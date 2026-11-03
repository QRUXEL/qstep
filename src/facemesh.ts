// One face's display mesh: planes flat with earcut, every other surface in its
// own (u, v) space (tess.ts). Faces that can't be meshed are skipped with a
// warning; a display mesh with a missing face is better than no model.
import earcut from 'earcut';
import { StepError, type Entity } from './parse';
import { tessellate } from './tess';
import type { Geometry } from './read';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

export interface FaceMeshOptions {
  /** largest turn of the normal across one triangle of a curved face, radians */
  maxAngle: number;
}

/** Appends the face's triangles to P (positions), N (normals) and I (indices). Returns false when the face was skipped. */
export function meshFace(G: Geometry, e: Entity, P: number[], N: number[], I: number[], o: FaceMeshOptions, warnings: string[]): boolean {
  if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') { G.warnOnce(`Faces of type ${e.type} are not drawn.`); return false; }
  const s = G.ent(e.args[2], 'surface');
  const sign = G.bool(e.args[3]) ? 1 : -1;
  let { loops, outer } = G.faceLoops(e);
  loops = loops.filter((l) => l.length >= 2);
  if (!loops.length) return false;
  const base = P.length / 3;

  if (s.type === 'PLANE') {
    const F = G.frame(s.args[1]);
    const n = scale(F.z, sign);
    const ax: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(ax, n)), w = cross(n, u);
    const area = (l: V3[]) => { let a = 0; for (let k = 0; k < l.length; k++) { const p = l[k], q = l[(k + 1) % l.length]; a += dot(p, u) * dot(q, w) - dot(q, u) * dot(p, w); } return Math.abs(a); };
    if (outer < 0) loops.forEach((l, k) => { if (outer < 0 || area(l) > area(loops[outer])) outer = k; });
    const order = [outer, ...loops.map((_, k) => k).filter((k) => k !== outer)].filter((k) => loops[k].length >= 3);
    const flat: number[] = [], holes: number[] = [], verts: V3[] = [];
    order.forEach((li, k) => {
      if (k > 0) holes.push(verts.length);
      for (const p of loops[li]) { verts.push(p); flat.push(dot(p, u), dot(p, w)); }
    });
    const tri = earcut(flat, holes.length ? holes : undefined, 2);
    for (const p of verts) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); }
    // earcut winding follows the input; make every triangle face along n
    for (let k = 0; k < tri.length; k += 3) {
      const a = verts[tri[k]], b = verts[tri[k + 1]], c = verts[tri[k + 2]];
      const ok = dot(cross(sub(b, a), sub(c, a)), n) >= 0;
      I.push(base + tri[k], base + (ok ? tri[k + 1] : tri[k + 2]), base + (ok ? tri[k + 2] : tri[k + 1]));
    }
    return true;
  }

  // a sliver face (a fillet a micron across): nothing to draw
  {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of loops.flat()) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 1e-3) return false;
  }
  let S;
  try { S = G.surfaceParam(s, loops.flat()); }
  catch (err) { if (!(err instanceof StepError)) throw err; S = null; }
  if (!S) { G.warnOnce(`Surfaces of type ${G.surfaceName(s)} are not drawn yet.`); return false; }
  const m = tessellate(S, loops, sign, { maxAngle: o.maxAngle });
  if (!m) { warnings.push(`Face #${e.id} (${G.surfaceName(s)}) could not be meshed.`); return false; }
  // no area in (u, v): a sliver face (a cone a few microns across, say) with nothing to draw
  if (!m.idx.length) return false;
  for (let k = 0; k < m.pos.length; k++) { P.push(m.pos[k]); N.push(m.nor[k]); }
  for (const i of m.idx) I.push(base + i);
  return true;
}
