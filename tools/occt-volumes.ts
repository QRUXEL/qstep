// Per-body mesh volume and area, qstep against OpenCascade (same order). Usage: OCCT=<path> bun tools/occt-volumes.ts <file.step>
import { parseStep, readMeshes } from "../src/index";
const file = process.argv[2];
const vol = (pos: ArrayLike<number>, idx: ArrayLike<number>) => {
  let v = 0, a = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [p, q, r] = [idx[k], idx[k + 1], idx[k + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  return { v, a };
};
const m = readMeshes(parseStep(await Bun.file(file).text()));
const occt = await (require(process.env.OCCT ?? "occt-import-js") as any)();
const r = occt.ReadStepFile(new Uint8Array(await Bun.file(file).arrayBuffer()), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.5, angularDeflection: 0.35 });
let ok = 0;
const bad: string[] = [];
m.bodies.forEach((b, i) => {
  const o = r.meshes[i];
  const mine = vol(b.pos, b.idx), theirs = vol(o.attributes.position.array, o.index.array);
  const dv = Math.abs(mine.v - theirs.v) / Math.max(1, Math.abs(theirs.v)), da = Math.abs(mine.a - theirs.a) / Math.max(1, theirs.a);
  if (dv < 0.01 && da < 0.02) ok++;
  else bad.push(`${i} ${b.name}: volume ${(mine.v / 1000).toFixed(2)} vs ${(theirs.v / 1000).toFixed(2)} cm³, area ${(mine.a / 100).toFixed(1)} vs ${(theirs.a / 100).toFixed(1)} cm², faces ${b.faces.length} vs ${o.brep_faces.length}`);
});
console.log(`${ok}/${m.bodies.length} bodies within 1% volume and 2% area of OpenCascade`);
console.log(bad.join("\n"));
