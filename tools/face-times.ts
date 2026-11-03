// The slowest faces to mesh in a file, by surface type. Usage: bun tools/face-times.ts <file.step> [limit seconds]
import { parseStep, readAssembly, geometry, meshFace, Ref, type Value } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const limit = Number(process.argv[3] ?? 50) * 1000;
const a = readAssembly(f);
const warnings: string[] = [];
const G = geometry(f, { chordTol: 0.05, maxArc: Math.PI / 12, mmPer: a.mmPer, point: (p) => p, dir: (d) => d, lenient: true }, warnings);
const byType = new Map<string, { n: number; ms: number; tris: number }>();
const slow: { id: number; type: string; ms: number; tris: number; pts: number }[] = [];
const start = performance.now();
outer: for (const id of [...(f.byType.get("ADVANCED_FACE") ?? [])]) {
  const e = f.entities.get(id)!;
  const s = G.ent(e.args[2], "s");
  const type = G.surfaceName(s);
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const t = performance.now();
  try { meshFace(G, e, P, N, I, { maxAngle: Math.PI / 12 }, warnings); } catch (err) { warnings.push(String(err)); }
  const ms = performance.now() - t;
  const r = byType.get(type) ?? { n: 0, ms: 0, tris: 0 };
  r.n++; r.ms += ms; r.tris += I.length / 3; byType.set(type, r);
  slow.push({ id, type, ms, tris: I.length / 3, pts: G.faceLoops(e).loops.flat().length });
  if (performance.now() - start > limit) { console.log("stopped at the time limit"); break outer; }
}
console.log([...byType].map(([k, v]) => `${k}: ${v.n} faces, ${v.ms.toFixed(0)} ms, ${v.tris} tris`).join("\n"));
console.log(slow.sort((x, y) => (process.env.BY_TRIS ? y.tris - x.tris : y.ms - x.ms)).slice(0, 12).map((s) => `#${s.id} ${s.type} ${s.ms.toFixed(0)} ms ${s.tris} tris ${s.pts} boundary pts`).join("\n"));
console.log(warnings.slice(0, 10).join("\n"));
