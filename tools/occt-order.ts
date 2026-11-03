// OpenCascade's mesh order and names next to qstep's instances, to keep body ids stable.
// Usage: OCCT=<path to occt-import-js> bun tools/occt-order.ts <file.step> [count]
import { parseStep, readAssembly, solidInstances } from "../src/index";
const file = process.argv[2], count = Number(process.argv[3] ?? 40);
const f = parseStep(await Bun.file(file).text());
const a = readAssembly(f);
const inst = solidInstances(a);
const occt = await (require(process.env.OCCT ?? "occt-import-js") as any)();
const r = occt.ReadStepFile(new Uint8Array(await Bun.file(file).arrayBuffer()), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 5, angularDeflection: 1 });
console.log(`occt ${r.meshes.length} meshes, qstep ${inst.length} instances`);
const tree = (n: any, d = 0): string => `${"  ".repeat(d)}${JSON.stringify(n.name)} meshes=${JSON.stringify(n.meshes)}\n` + (n.children ?? []).slice(0, 6).map((c: any) => tree(c, d + 1)).join("");
console.log(tree(r.root).split("\n").slice(0, 30).join("\n"));
for (let k = 0; k < Math.min(count, Math.max(r.meshes.length, inst.length)); k++) {
  const m = r.meshes[k], i = inst[k];
  const leaf = i?.path[i.path.length - 1];
  console.log(k, JSON.stringify(m?.name), JSON.stringify(m?.color), "|", JSON.stringify(leaf?.instance), JSON.stringify(leaf?.name), a.solidNames.get(i?.solid), a.colors.get(i?.solid));
}
