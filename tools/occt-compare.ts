// qstep's assembly (instances + placements) against OpenCascade's meshes for the same file.
// Usage: OCCT=<path to occt-import-js> bun tools/occt-compare.ts <file.step> [names,to,print]
import { parseStep, Ref, type Value, readAssembly, solidInstances, applyXf, type V3 } from "../src/index";


const file = process.argv[2];
const text = await Bun.file(file).text();
let t = performance.now();
const f = parseStep(text);
const tParse = performance.now() - t;
t = performance.now();
const a = readAssembly(f);
const inst = solidInstances(a);
const tAsm = performance.now() - t;
console.log(`qstep: parse ${tParse.toFixed(0)} ms, assembly ${tAsm.toFixed(0)} ms, ${inst.length} placed solids, ${f.entities.size} entities; warnings: ${a.warnings.join(" | ") || "none"}`);

// vertices of a solid (file units → mm)
const E = f.entities;
const verts = (solid: number): V3[] => {
    const out: V3[] = [];
    const seen = new Set<number>();
    const walk = (v: Value, depth: number) => {
        if (depth > 12) return;
        if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
        if (!(v instanceof Ref) || seen.has(v.id)) return;
        seen.add(v.id);
        const e = E.get(v.id);
        if (!e) return;
        if (e.type === "CARTESIAN_POINT") return;
        if (e.type === "VERTEX_POINT") { const c = E.get((e.args[1] as Ref).id)!.args[1] as number[]; out.push([c[0] * a.mmPer, c[1] * a.mmPer, (c[2] ?? 0) * a.mmPer]); return; }
        if (["LINE", "CIRCLE", "ELLIPSE", "PLANE", "CYLINDRICAL_SURFACE", "CONICAL_SURFACE", "AXIS2_PLACEMENT_3D", "DIRECTION", "VECTOR"].includes(e.type) || e.type.startsWith("B_SPLINE") || e.parts) return;
        e.args.forEach((x) => walk(x, depth + 1));
    };
    walk(new Ref(solid), 0);
    return out;
};
const box = (ps: V3[]) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of ps) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    return { lo, hi };
};
const mine = inst.map((i) => ({ name: i.path[i.path.length - 1].instance ?? i.path[i.path.length - 1].name, box: box(verts(i.solid).map((p) => applyXf(i.placement, p))) }));

t = performance.now();
const occt = await (require(process.env.OCCT ?? "occt-import-js") as any)();
const r = occt.ReadStepFile(new Uint8Array(await Bun.file(file).arrayBuffer()), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 5, angularDeflection: 1 });
console.log(`occt: ${((performance.now() - t) / 1000).toFixed(1)} s, ${r.meshes.length} meshes`);
const theirs = r.meshes.map((m: any) => { const p = m.attributes.position.array; const ps: V3[] = []; for (let i = 0; i < p.length; i += 3) ps.push([p[i], p[i + 1], p[i + 2]]); return { name: m.name, box: box(ps) }; });

// match each OCCT mesh to the qstep instance with the nearest box (meshes don't reach the exact vertices on curves: 1 mm slack)
const used = new Set<number>();
let ok = 0;
const bad: string[] = [];
for (const o of theirs) {
    let best = -1, bd = Infinity;
    mine.forEach((m, i) => {
        if (used.has(i)) return;
        const d = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(m.box.lo[k] - o.box.lo[k]), Math.abs(m.box.hi[k] - o.box.hi[k])]));
        if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0 && bd < 1.5) { used.add(best); ok++; }
    else bad.push(`${o.name}: nearest ${best >= 0 ? mine[best].name : "-"} off by ${bd.toFixed(2)} mm`);
}
console.log(`matched ${ok}/${theirs.length} OCCT meshes to qstep instances (${mine.length} qstep instances)`);
console.log(bad.slice(0, 12).join("\n"));
for (const name of (process.argv[3] ?? "").split(",").filter(Boolean)) {
    const fmt = (b: { lo: number[]; hi: number[] }) => `[${b.lo.map((v) => v.toFixed(1)).join(", ")}] – [${b.hi.map((v) => v.toFixed(1)).join(", ")}]`;
    mine.filter((m) => m.name === name).forEach((m) => console.log(`qstep ${name}: ${fmt(m.box)}`));
    theirs.filter((o: any) => o.name === name).forEach((o: any) => console.log(`occt  ${name}: ${fmt(o.box)}`));
}
