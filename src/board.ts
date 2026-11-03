// Boards in any orientation: a solid's own frame with its thickness along Z,
// found from its flat faces, then read with the 2.5D reader (brep.ts) in that
// frame. Solids that aren't boards (hardware, turned parts) are reported with
// the reason instead of failing the file.
import { Ref, Enum, StepError, type Entity, type StepFile, type Value } from './parse';
import { solidParts, type Part, type ReadOptions } from './brep';
import { lengthUnit, type V3, type Xf } from './assembly';
import { curveAt, curveDomain, expandKnots, type Curve } from './nurbs';

export interface Board {
  solid: number;
  name: string;
  /** board frame → file coordinates (mm): Z from the bottom face up through the board, X along its longest straight bottom edge */
  frame: Xf;
  thickness: number;
  /** outline, holes, pockets, faces and mesh in the board frame (bottom at z = 0) */
  part: Part;
}
export interface NotBoard { solid: number; name: string; reason: string }

const SOLID_TYPES = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS'];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * The board frame of a solid, as ManualNest's importer picks it: the bottom is
 * the largest flat side (coplanar faces together) that has a parallel side
 * facing the other way; Z runs from it up through the board.
 */
export function boardFrame(f: StepFile, solid: number, mmPer = lengthUnit(f).mmPer): { frame: Xf; thickness: number } | { reason: string } {
  const E = f.entities;
  const get = (v: Value | undefined): Entity | undefined => (v instanceof Ref ? E.get(v.id) : undefined);
  const xyz = (v: Value | undefined): V3 | null => {
    const c = get(v)?.args[1] as number[] | undefined;
    return c ? [c[0] * mmPer, c[1] * mmPer, (c[2] ?? 0) * mmPer] : null;
  };
  const dirOf = (v: Value | undefined): V3 | null => {
    const c = get(v)?.args[1] as number[] | undefined;
    return c ? norm([c[0], c[1], c[2] ?? 0]) : null;
  };
  const axes = (pl: Entity | undefined) => {
    const o = xyz(pl?.args[1]);
    const z = dirOf(pl?.args[2]) ?? [0, 0, 1];
    let x = dirOf(pl?.args[3]) ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] as V3 : [0, 1, 0] as V3);
    x = norm(sub(x, [z[0] * dot(x, z), z[1] * dot(x, z), z[2] * dot(x, z)]));
    return o ? { o, x, y: cross(z, x) } : null;
  };
  /** A few points along an edge's curve between its ends a → b (arcs the way the edge runs, splines over their range). */
  const curveSamples = (c: Entity, a: V3, b: V3, sense: boolean): V3[] => {
    if (c.type === 'CIRCLE' || c.type === 'ELLIPSE') {
      const F = axes(get(c.args[1]));
      if (!F) return [];
      const r1 = Number(c.args[2]) * mmPer, r2 = c.type === 'ELLIPSE' ? Number(c.args[3]) * mmPer : r1;
      const ang = (p: V3) => { const d = sub(p, F.o); return Math.atan2(dot(d, F.y) / r2, dot(d, F.x) / r1); };
      const t0 = ang(a);
      let t1 = ang(b);
      const closed = Math.hypot(...sub(a, b)) < 1e-6;
      if (sense) { while (t1 <= t0 + (closed ? 1e-9 : 0)) t1 += 2 * Math.PI; }
      else { while (t1 >= t0 - (closed ? 1e-9 : 0)) t1 -= 2 * Math.PI; }
      const out: V3[] = [];
      for (let k = 1; k < 16; k++) {
        const t = t0 + ((t1 - t0) * k) / 16;
        out.push([0, 1, 2].map((i) => F.o[i] + r1 * Math.cos(t) * F.x[i] + r2 * Math.sin(t) * F.y[i]) as V3);
      }
      return out;
    }
    const simple = c.type === 'B_SPLINE_CURVE_WITH_KNOTS';
    const head = simple ? c.args.slice(1, 3) : c.parts?.B_SPLINE_CURVE;
    const knotPart = simple ? c.args.slice(6, 8) : c.parts?.B_SPLINE_CURVE_WITH_KNOTS;
    if (!head || !knotPart) return [];
    const P = (head[1] as Value[]).map(xyz).filter((p): p is V3 => Boolean(p));
    const weights = c.parts?.RATIONAL_B_SPLINE_CURVE?.[0] as Value[] | undefined;
    const curve: Curve = { p: Number(head[0]), P, U: expandKnots((knotPart[0] as Value[]).map(Number), (knotPart[1] as Value[]).map(Number)), W: weights ? weights.map(Number) : null };
    const [u0, u1] = curveDomain(curve);
    return Array.from({ length: 31 }, (_, k) => curveAt(curve, u0 + ((u1 - u0) * (k + 1)) / 32));
  };
  const s = E.get(solid);
  if (!s) return { reason: `#${solid} is missing` };
  let shell = get(s.args[1]);
  if (shell?.type === 'ORIENTED_CLOSED_SHELL') shell = get(shell.args[2]);
  const faceRefs = (shell?.args[1] as Value[] | undefined) ?? [];

  // every vertex (for the extent along Z) and every plane face (for the frame)
  const vertices: V3[] = [];
  const planes: { n: V3; d: number; area: number; lines: [V3, V3][] }[] = [];
  for (const fr of faceRefs) {
    const face = get(fr);
    if (!face) continue;
    const surf = get(face.args[2]);
    const loops: { outer: boolean; pts: V3[]; lines: [V3, V3][] }[] = [];
    for (const bv of (face.args[1] as Value[]) ?? []) {
      const bound = get(bv);
      const loop = get(bound?.args[1]);
      if (loop?.type !== 'EDGE_LOOP') continue; // a VERTEX_LOOP (cone tip) has no edges
      const pts: V3[] = [];
      const lines: [V3, V3][] = [];
      for (const oe of (loop?.args[1] as Value[] | undefined) ?? []) {
        const o = get(oe);
        const edge = get(o?.args[3]);
        if (!edge) continue;
        const a = xyz(get(edge.args[1])?.args[1]), b = xyz(get(edge.args[2])?.args[1]);
        if (!a || !b) continue;
        const forward = o!.args[4] instanceof Enum && o!.args[4].v === 'T';
        const [p, q] = forward ? [a, b] : [b, a];
        vertices.push(a, b);
        const curve = get(edge.args[3]);
        let c = curve;
        while (c && (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE')) c = get(c.args[1]);
        if (c?.type === 'LINE') lines.push([p, q]);
        // Points along curved edges for the extents (a rod's length may be all in its thread curves).
        if (c) vertices.push(...curveSamples(c, a, b, edge.args[4] instanceof Enum && edge.args[4].v === 'T'));
        if (c?.type === 'CIRCLE' && Math.hypot(...sub(a, b)) < 1e-6) {
          // a full circle: sample it so the face gets its area
          const pl = get(c.args[1]);
          const o2 = xyz(pl?.args[1]), z = dirOf(pl?.args[2]) ?? [0, 0, 1];
          const r = Number(c.args[2]) * mmPer;
          if (o2) {
            let x = dirOf(pl?.args[3]) ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
            x = norm(sub(x, [z[0] * dot(x, z), z[1] * dot(x, z), z[2] * dot(x, z)]));
            const y = cross(z, x);
            for (let k = 0; k < 24; k++) {
              const t = (k / 24) * 2 * Math.PI * (forward ? 1 : -1);
              const q: V3 = [o2[0] + r * (Math.cos(t) * x[0] + Math.sin(t) * y[0]), o2[1] + r * (Math.cos(t) * x[1] + Math.sin(t) * y[1]), o2[2] + r * (Math.cos(t) * x[2] + Math.sin(t) * y[2])];
              pts.push(q);
              vertices.push(q);
            }
            continue;
          }
        }
        pts.push(p);
      }
      loops.push({ outer: bound?.type === 'FACE_OUTER_BOUND', pts, lines });
    }
    if (surf?.type !== 'PLANE') continue;
    const axis = get(surf.args[1]);
    const z = dirOf(axis?.args[2]) ?? [0, 0, 1];
    const sense = face.args[3] instanceof Enum && face.args[3].v === 'T' ? 1 : -1;
    const n: V3 = [z[0] * sense, z[1] * sense, z[2] * sense];
    const origin = xyz(axis?.args[1]) ?? [0, 0, 0];
    // area inside the outer loop less the holes (Newell; the largest loop is the outer one when unmarked)
    const areas = loops.map((l) => {
      let N: V3 = [0, 0, 0];
      for (let k = 0; k < l.pts.length; k++) {
        const c3 = cross(l.pts[k], l.pts[(k + 1) % l.pts.length]);
        N = [N[0] + c3[0], N[1] + c3[1], N[2] + c3[2]];
      }
      return Math.abs(dot(N, n)) / 2;
    });
    let outer = loops.findIndex((l) => l.outer);
    if (outer < 0) outer = areas.indexOf(Math.max(...areas, 0));
    const area = (areas[outer] ?? 0) - areas.reduce((sum, a, k) => (k === outer ? sum : sum + a), 0);
    planes.push({ n, d: dot(n, origin), area: Math.max(0, area), lines: loops.flatMap((l) => l.lines) });
  }
  if (!vertices.length) return { reason: 'no edges' };

  // coplanar faces together (same outward normal and offset)
  const groups: { n: V3; d: number; area: number; lines: [V3, V3][] }[] = [];
  for (const p of planes) {
    const g = groups.find((q) => dot(q.n, p.n) > 0.9999 && Math.abs(q.d - p.d) < 0.01);
    if (g) { g.area += p.area; g.lines.push(...p.lines); }
    else groups.push({ ...p, lines: [...p.lines] });
  }
  // A board's bottom and top are outer sides: nothing of the solid lies beyond them
  // (a shoulder half way along a rod is not a bottom).
  const outermost = (g: { n: V3; d: number }) => vertices.every((v) => dot(g.n, v) <= g.d + 0.01);
  const outer = groups.filter(outermost);
  const paired = outer.filter((g) => outer.some((h) => h !== g && dot(h.n, g.n) < -0.9999));
  if (!paired.length) return { reason: 'no two flat outer sides facing away from each other (not a board)' };
  const bottom = paired.reduce((best, g) => (g.area > best.area ? g : best));
  const z: V3 = [-bottom.n[0], -bottom.n[1], -bottom.n[2]];

  // X along the longest straight edge of the bottom (rectangular boards come out square to the axes)
  let x: V3 | null = null, longest = 0;
  for (const [a, b] of bottom.lines) {
    const d = sub(b, a);
    const along = sub(d, [z[0] * dot(d, z), z[1] * dot(d, z), z[2] * dot(d, z)]);
    const l = Math.hypot(...along);
    if (l > longest + 1e-6) { longest = l; x = norm(along); }
  }
  if (!x) x = norm(cross(Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], z));
  const y = cross(z, x);
  // origin on the bottom plane
  const zs = vertices.map((v) => dot(v, z));
  const z0 = -bottom.d; // the bottom plane is dot(z, p) = -d
  const o: V3 = [z[0] * z0, z[1] * z0, z[2] * z0];
  const thickness = Math.max(...zs) - z0;
  // A board is thinner than it is wide: rods, motors and blocks are not.
  const across = (axis: V3) => { const v = vertices.map((p) => dot(p, axis)); return Math.max(...v) - Math.min(...v); };
  const width = Math.min(across(x), across(y));
  if (thickness > width + 1e-6) return { reason: `${thickness.toFixed(1)} mm thick but only ${width.toFixed(1)} mm wide (not a board)` };
  return { frame: { r: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: o }, thickness };
}

/** Every solid of the file (or the given ones) as a board in its own frame, or the reason it isn't one. */
export function readBoards(f: StepFile, solids?: number[], opt: ReadOptions = {}): { boards: Board[]; other: NotBoard[]; warnings: string[] } {
  const { mmPer } = lengthUnit(f);
  const ids = solids ?? SOLID_TYPES.flatMap((t) => f.byType.get(t) || []);
  const boards: Board[] = [];
  const other: NotBoard[] = [];
  const warnings: string[] = [];
  for (const solid of ids) {
    const e = f.entities.get(solid);
    const name = typeof e?.args[0] === 'string' ? e.args[0] : `Body #${solid}`;
    const fr = boardFrame(f, solid, mmPer);
    if ('reason' in fr) { other.push({ solid, name, reason: fr.reason }); continue; }
    const { r, t } = fr.frame;
    // file → board: Rᵀ·(p − t)
    const toBoard = (p: V3): V3 => {
      const d = sub(p, t);
      return [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
    };
    const dirToBoard = (d: V3): V3 => [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
    const solidWarnings: string[] = [];
    try {
      const [part] = solidParts(f, [solid], { chordTol: opt.chordTol ?? 0.01, zTol: opt.zTol ?? 0.02, mmPer, point: toBoard, dir: dirToBoard }, solidWarnings);
      boards.push({ solid, name, frame: fr.frame, thickness: part.thickness, part });
      warnings.push(...solidWarnings.map((w) => `${name}: ${w}`));
    } catch (err) {
      other.push({ solid, name, reason: err instanceof StepError ? err.message : String(err) });
    }
  }
  return { boards, other, warnings };
}
