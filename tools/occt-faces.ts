// Faces whose orientation or area differs from OpenCascade's, per body. Usage: OCCT=<path> bun tools/occt-faces.ts <file.step>
import { parseStep, readMeshes } from "../src/index";
const file = process.argv[2];
const f = parseStep(await Bun.file(file).text());
const m = readMeshes(f);
const occt = await (require(process.env.OCCT ?? "occt-import-js") as any)();
const r = occt.ReadStepFile(new Uint8Array(await Bun.file(file).arrayBuffer()), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.5, angularDeflection: 0.35 });
// area, and volume contribution about a fixed point (the body's first vertex)
const stats = (pos: ArrayLike<number>, idx: ArrayLike<number>, t0: number, t1: number, o: number[]) => {
  let v = 0, a = 0;
  for (let t = t0; t <= t1; t++) {
    const [p, q, s] = [0, 1, 2].map((j) => { const i = idx[t * 3 + j]; return [pos[i * 3] - o[0], pos[i * 3 + 1] - o[1], pos[i * 3 + 2] - o[2]]; });
    v += (p[0] * (q[1] * s[2] - q[2] * s[1]) - p[1] * (q[0] * s[2] - q[2] * s[0]) + p[2] * (q[0] * s[1] - q[1] * s[0])) / 6;
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  return { v, a };
};
const seen = new Set<number>();
const tally = new Map<string, number>();
m.bodies.forEach((b, i) => {
  if (seen.has(b.solid)) return;
  seen.add(b.solid);
  const om = r.meshes[i], op = om.attributes.position.array, oi = om.index.array;
  const o = [op[0], op[1], op[2]];
  // faces by order: qstep skips slivers, so match on the face list in order of the shell
  const faceIds = b.faces.map((x) => x.face);
  if (om.brep_faces.length !== faceIds.length) { console.log(`${i} ${b.name}: ${faceIds.length} vs ${om.brep_faces.length} faces, skipped`); return; }
  b.faces.forEach((fr, k) => {
    const mine = stats(b.pos, b.idx, fr.first, fr.last, o), theirs = stats(op, oi, om.brep_faces[k].first, om.brep_faces[k].last, o);
    const flip = Math.abs(theirs.v) > 1 && Math.sign(mine.v) !== Math.sign(theirs.v);
    const areaOff = Math.abs(mine.a - theirs.a) > 0.03 * Math.max(theirs.a, 10);
    if (!flip && !areaOff) return;
    const e = f.entities.get(fr.face)!, s = f.entities.get((e.args[2] as any).id)!;
    const type = s.parts ? "B_SPLINE (complex)" : s.type;
    const key = `${type}${flip ? " flipped" : ""}${areaOff ? " area" : ""}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if ((tally.get(key) ?? 0) <= 3) console.log(`${i} ${b.name} face #${fr.face} ${type} sense=${(e.args[3] as any).v}: vol ${mine.v.toFixed(0)} vs ${theirs.v.toFixed(0)}, area ${mine.a.toFixed(1)} vs ${theirs.a.toFixed(1)}`);
  });
});
console.log([...tally].map(([k, n]) => `${k}: ${n}`).join("\n"));
