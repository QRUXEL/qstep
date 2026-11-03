// Usage: bun tools/extent.ts <file.step> <solid name> — the solid's file-space extent and its flat faces
import { parseStep, Ref, boardFrame } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const E = f.entities;
const g = (v: any) => (v instanceof Ref ? E.get(v.id) : undefined);
const id = (f.byType.get("MANIFOLD_SOLID_BREP") || []).find((i) => E.get(i)!.args[0] === process.argv[3])!;
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const fr of g(E.get(id)!.args[1])!.args[1] as any[]) {
  const face = g(fr)!; const s = g(face.args[2])!;
  for (const b of face.args[1] as any[]) { const lp = g(g(b)!.args[1])!; if (lp.type !== "EDGE_LOOP") continue; for (const oe of lp.args[1] as any[]) { const ed = g(g(oe)!.args[3])!; for (const vi of [1, 2]) { const c = g(g(ed.args[vi])!.args[1])!.args[1] as number[]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] * 1000); hi[k] = Math.max(hi[k], c[k] * 1000); } } } }
  if (s.type === "PLANE") { const ax = g(s.args[1])!; const z = g(ax.args[2])!.args[1] as number[]; const o = g(ax.args[1])!.args[1] as number[]; const sense = face.args[3].v === "T" ? 1 : -1; console.log(`plane n=(${z.map((v) => (v * sense).toFixed(2)).join(",")}) at ${o.map((v) => (v * 1000).toFixed(1)).join(",")}`); }
}
console.log("extent mm", hi.map((v, k) => (v - lo[k]).toFixed(2)).join(" × "));
console.log(JSON.stringify(boardFrame(f, id)));
