import { parseStep, Ref } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const E = f.entities;
const g = (v: any) => (v instanceof Ref ? E.get(v.id) : undefined);
for (const id of f.byType.get("MANIFOLD_SOLID_BREP") || []) {
  if (E.get(id)!.args[0] !== process.argv[3]) continue;
  const zs: number[] = []; const kinds = new Map<string, number[]>();
  const shell = g(E.get(id)!.args[1])!;
  for (const fr of shell.args[1] as any[]) {
    const face = g(fr)!; const s = g(face.args[2])!;
    for (const b of face.args[1] as any[]) { const lp = g(g(b)!.args[1])!; if (lp.type !== "EDGE_LOOP") continue; for (const oe of lp.args[1] as any[]) { const ed = g(g(oe)!.args[3])!; for (const vi of [1, 2]) { const c = g(g(ed.args[vi])!.args[1])!.args[1] as number[]; zs.push(c[2]); const k = s.type; kinds.set(k, [...(kinds.get(k) ?? []), c[2]]); } } }
  }
  console.log("vertex z", Math.min(...zs).toFixed(1), Math.max(...zs).toFixed(1));
  for (const [k, v] of kinds) console.log(k, Math.min(...v).toFixed(1), Math.max(...v).toFixed(1));
}
