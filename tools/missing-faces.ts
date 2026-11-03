// Faces of a body that came out with no triangles. Usage: bun tools/missing-faces.ts <file.step> <body name>
import { parseStep, readMeshes, geometry, Ref } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const m = readMeshes(f);
const b = m.bodies.find((x) => x.name === process.argv[3])!;
const have = new Set(b.faces.map((x) => x.face));
const solid = f.entities.get(b.solid)!;
const shell = f.entities.get((solid.args[1] as Ref).id)!;
const G = geometry(f, { chordTol: 0.05, mmPer: m.assembly.mmPer, point: (p) => p, dir: (d) => d, lenient: true }, []);
for (const fv of shell.args[1] as Ref[]) {
  if (have.has(fv.id)) continue;
  const e = f.entities.get(fv.id)!, s = G.ent(e.args[2], "s");
  const { loops } = G.faceLoops(e);
  const pts = loops.flat();
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  console.log(`#${fv.id} ${G.surfaceName(s)} loops ${loops.map((l) => l.length)} extent ${hi.map((h, k) => (h - lo[k]).toFixed(3)).join(" x ")}`);
}
console.log(m.warnings.filter((w) => w.includes("could not")).slice(0, 5));
