// Usage: bun tools/instance.ts <file.step> <instance index,...> — one placed solid: its extent, flat faces and board reading
import { parseStep, Ref, readAssembly, solidInstances, readBoards, ringArea } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const E = f.entities;
const g = (v: any) => (v instanceof Ref ? E.get(v.id) : undefined);
const a = readAssembly(f);
const inst = solidInstances(a);
for (const n of process.argv[3].split(",").map(Number)) {
  const i = inst[n];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const planes: string[] = [];
  for (const fr of g(E.get(i.solid)!.args[1])!.args[1] as any[]) {
    const face = g(fr)!; const s = g(face.args[2])!;
    for (const b of face.args[1] as any[]) { const lp = g(g(b)!.args[1])!; if (lp.type !== "EDGE_LOOP") continue; for (const oe of lp.args[1] as any[]) { const ed = g(g(oe)!.args[3])!; for (const vi of [1, 2]) { const c = g(g(ed.args[vi])!.args[1])!.args[1] as number[]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] * a.mmPer); hi[k] = Math.max(hi[k], c[k] * a.mmPer); } } } }
    if (s.type === "PLANE") { const ax = g(s.args[1])!; const z = g(ax.args[2])!.args[1] as number[]; const sense = face.args[3].v === "T" ? 1 : -1; planes.push(`(${z.map((v) => Math.round(v * sense * 100) / 100).join(",")})`); }
  }
  const b = readBoards(f, [i.solid]);
  console.log(`#${n} ${i.path.map((p) => p.instance ?? p.name).join(" / ")} solid #${i.solid}: extent ${hi.map((v, k) => (v - lo[k]).toFixed(2)).join(" × ")} mm; plane normals ${[...new Set(planes)].join(" ")}`);
  console.log(b.boards[0] ? `   board ${b.boards[0].thickness.toFixed(2)} thick, outline ${Math.abs(ringArea(b.boards[0].part.outline)).toFixed(1)} mm², bbox ${b.boards[0].part.bbox.map((v) => v.toFixed(1))}` : `   ${b.other[0].reason}`);
}
