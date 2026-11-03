// Meshes a whole file and checks every body: triangle count, time, closed-solid volume (should be positive).
// Usage: bun tools/meshes.ts <file.step>
import { parseStep, readMeshes } from "../src/index";
const t0 = performance.now();
const f = parseStep(await Bun.file(process.argv[2]).text());
const t1 = performance.now();
const m = readMeshes(f);
const t2 = performance.now();
let tris = 0, neg = 0;
const vols: string[] = [];
for (const b of m.bodies) {
  tris += b.idx.length / 3;
  let v = 0;
  for (let k = 0; k < b.idx.length; k += 3) {
    const [a, c, d] = [b.idx[k], b.idx[k + 1], b.idx[k + 2]].map((i) => [b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]]);
    v += (a[0] * (c[1] * d[2] - c[2] * d[1]) - a[1] * (c[0] * d[2] - c[2] * d[0]) + a[2] * (c[0] * d[1] - c[1] * d[0])) / 6;
  }
  if (v <= 0) neg++;
  vols.push(`${b.name}: ${(v / 1000).toFixed(2)} cm³, ${b.idx.length / 3} tris, ${b.faces.length} faces`);
}
console.log(`parse ${(t1 - t0).toFixed(0)} ms, mesh ${(t2 - t1).toFixed(0)} ms, ${m.bodies.length} bodies, ${tris} triangles, ${neg} with volume ≤ 0`);
console.log(`warnings (${m.warnings.length}):`, m.warnings.slice(0, 15).join("\n  "));
if (process.argv[3]) console.log(vols.join("\n"));
