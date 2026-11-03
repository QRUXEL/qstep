// Per-face area and volume contribution of one body, to find inside-out faces. Usage: bun tools/body-faces.ts <file.step> <body name>
import { parseStep, readMeshes } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const m = readMeshes(f);
const b = m.bodies.find((x) => x.name === process.argv[3])!;
for (const fr of b.faces) {
  let v = 0, a = 0;
  for (let t = fr.first; t <= fr.last; t++) {
    const [p, q, r] = [0, 1, 2].map((j) => { const i = b.idx[t * 3 + j]; return [b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]]; });
    v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  const e = f.entities.get(fr.face)!, s = f.entities.get((e.args[2] as any).id)!;
  console.log(`#${fr.face} ${s.type} sense=${(e.args[3] as any).v} tris=${fr.last - fr.first + 1} area=${a.toFixed(1)} vol=${(v / 1000).toFixed(2)}`);
}
