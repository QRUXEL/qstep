// Usage: bun tools/curves.ts <file.step> <solid name> — edge curve and surface types of one solid
import { parseStep, Ref } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const E = f.entities;
const g = (v: any) => (v instanceof Ref ? E.get(v.id) : undefined);
for (const id of f.byType.get("MANIFOLD_SOLID_BREP") || []) {
  if (E.get(id)!.args[0] !== process.argv[3]) continue;
  const curves = new Map<string, number>(), surfs = new Map<string, number>();
  let shell = g(E.get(id)!.args[1]);
  for (const fr of shell!.args[1] as any[]) {
    const face = g(fr)!;
    const s = g(face.args[2])!; surfs.set(s.type, (surfs.get(s.type) ?? 0) + 1);
    for (const b of face.args[1] as any[]) { const lp = g(g(b)!.args[1])!; for (const oe of (lp.args[1] as any[]) ?? []) { const c = g(g(g(oe)!.args[3])!.args[3])!; curves.set(c.type, (curves.get(c.type) ?? 0) + 1); } }
  }
  console.log("surfaces", Object.fromEntries(surfs)); console.log("curves", Object.fromEntries(curves));
}
