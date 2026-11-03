// One face: its surface, loops in 3D and in (u, v). Usage: bun tools/face.ts <file.step> <face id>
import { parseStep, readAssembly, geometry, tessellate } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const a = readAssembly(f);
const w: string[] = [];
const G = geometry(f, { chordTol: 0.05, maxArc: Math.PI / 12, mmPer: a.mmPer, point: (p) => p, dir: (d) => d, lenient: true }, w);
const e = f.entities.get(Number(process.argv[3]))!;
const s = G.ent(e.args[2], "s");
console.log(e.type, "same_sense", G.bool(e.args[3]), s.type, JSON.stringify(s.args));
const { loops, outer } = G.faceLoops(e);
const S = G.surfaceParam(s, loops.flat())!;
console.log("outer", outer, "loops", loops.map((l) => l.length));
for (const l of loops) { let h: any = null; console.log(l.slice(0, 40).map((p) => { const q = S.inv(p, h); h = q; return `(${q[0].toFixed(3)},${q[1].toFixed(3)})`; }).join(" ")); }
const m = tessellate(S, loops, G.bool(e.args[3]) ? 1 : -1, { maxAngle: Math.PI / 12 });
console.log("tris", m ? m.idx.length / 3 : null, w);
