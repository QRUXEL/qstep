// B-rep reader for 2.5D sheet parts (what ManualNest and similar nesting tools
// export, or a CAD system like Onshape): planes, cylinders, cones and B-spline
// surfaces bounded by lines, circles, ellipses and B-spline curves.
// Anything else is refused with a clear message instead of being guessed.
//
// Output per solid: top/bottom z, footprint outline + through-holes, pocket
// levels (cumulative, from the top and from the bottom), top/bottom faces and a
// triangle mesh for the 3D view.
import earcut from 'earcut';
import { Ref, Enum, Typed, StepError, type StepFile, type Value, type Entity } from './parse';
import { union, simplify, round3, ringArea, type Poly, type Ring, type Pt } from './geom/clip';
import { expandKnots, sampleCurve, surfaceAt, surfaceDomain, surfaceNormal, type Curve, type Surface } from './nurbs';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface PocketLevel {
  z: number; depth: number; area: number; poly: Ring; holes: Ring[]; from: 'top' | 'bottom';
}
export interface PartMesh { pos: Float32Array; nor: Float32Array; idx: Uint32Array }
export interface Part {
  index: number;
  label: string;
  zmin: number; zmax: number; thickness: number;
  bbox: [number, number, number, number];
  outline: Ring;
  holes: Ring[];
  pockets: PocketLevel[];
  topFaces: Poly[];
  bottomFaces: Poly[];
  /** footprint area and perimeter, used to match parts when a STEP file is replaced */
  area: number;
  perimeter: number;
  mesh: PartMesh;
}
export interface StepModel {
  source: string;               // FILE_NAME / originating system
  unit: string;
  parts: Part[];
  bbox: [number, number, number, number];
  thickness: number;
  warnings: string[];
  /** the file's parts stood on their side and were turned to lie flat: X or Y was the thin axis */
  turned?: 'x' | 'y';
}

export interface ReadOptions {
  /** max chord error when sampling arcs, mm */
  chordTol?: number;
  /** z tolerance for "flat" and "at the top" tests, mm */
  zTol?: number;
}

const SUPPORTED_SURFACES = new Set(['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE']);
const SUPPORTED_CURVES = new Set(['LINE', 'CIRCLE', 'ELLIPSE', 'B_SPLINE_CURVE', 'POLYLINE']);

export function readModel(f: StepFile, opt: ReadOptions = {}): StepModel {
  const chordTol = opt.chordTol ?? 0.01;
  const zTol = opt.zTol ?? 0.02;
  const E = f.entities;
  const warnings: string[] = [];

  const ent = (v: Value, ctx: string): Entity => {
    if (!(v instanceof Ref)) throw new StepError(`${ctx}: expected a reference`);
    const e = E.get(v.id);
    if (!e) throw new StepError(`${ctx}: #${v.id} is missing from the file`);
    return e;
  };
  const num = (v: Value) => (v instanceof Typed ? Number(v.args[0]) : Number(v));
  const bool = (v: Value) => v instanceof Enum && v.v === 'T';

  // ---- units: length unit of the geometric context → millimetres
  let mmPer = 1, unit = 'mm';
  for (const id of f.byType.get('LENGTH_UNIT') || []) {
    const e = E.get(id)!;
    const si = e.parts?.SI_UNIT;
    if (si) {
      const prefix = si[0] instanceof Enum ? si[0].v : null;
      mmPer = prefix === 'MILLI' ? 1 : prefix === 'CENTI' ? 10 : prefix === 'DECI' ? 100 : prefix === null ? 1000 : prefix === 'MICRO' ? 0.001 : 1;
      unit = prefix ? prefix.toLowerCase() + 'metre' : 'metre';
    }
    const conv = e.parts?.CONVERSION_BASED_UNIT;
    if (conv && typeof conv[0] === 'string') {
      const name = conv[0].toUpperCase();
      if (name.includes('INCH')) { mmPer = 25.4; unit = 'inch'; }
      else if (name.includes('FOOT')) { mmPer = 304.8; unit = 'foot'; }
    }
    break;
  }

  // ---- lying flat: boards are read with their thickness along Z. A part drawn standing up
  // (Onshape's Front plane, say) is turned so its thinnest direction becomes Z.
  let turn = (p: V3): V3 => p;
  let turned: 'x' | 'y' | undefined;
  {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of f.byType.get('VERTEX_POINT') || []) {
      const pe = E.get(id)!, c = E.get((pe.args[1] as Ref).id)?.args[1] as number[] | undefined;
      if (!c) continue;
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] ?? 0); hi[k] = Math.max(hi[k], c[k] ?? 0); }
    }
    const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
    if (ext.every(Number.isFinite)) {
      const thin = ext.indexOf(Math.min(...ext));
      if (thin !== 2 && ext[thin] < 0.5 * ext[2]) {
        // proper rotations: Y thin -> (x, z, -y); X thin -> (y, z, x)
        turn = thin === 1 ? (p) => [p[0], p[2], -p[1]] : (p) => [p[1], p[2], p[0]];
        turned = thin === 1 ? 'y' : 'x';
        warnings.push(`The parts stand on their side in the file (thinnest along ${'XYZ'[thin]}); they were turned to lie flat.`);
      }
    }
  }

  // ---- solids
  const brepIds = [...(f.byType.get('MANIFOLD_SOLID_BREP') || []), ...(f.byType.get('BREP_WITH_VOIDS') || [])];
  if (!brepIds.length) {
    const shells = f.byType.get('SHELL_BASED_SURFACE_MODEL');
    throw new StepError(shells ? 'The file holds surface models, not solids. Export the parts as solid bodies.' : 'No solid bodies were found in the file.');
  }
  const unsupportedXf = (f.byType.get('ITEM_DEFINED_TRANSFORMATION') || []).length;
  if (unsupportedXf) warnings.push(`The file contains ${unsupportedXf} assembly placement(s); parts are read at their stored positions.`);
  const parts = solidParts(f, brepIds, { chordTol, zTol, mmPer, point: turn, dir: turn }, warnings);

  const bx = parts.map((p) => p.bbox);
  const fn = f.header.FILE_NAME;
  return {
    source: fn ? String((fn[3] as Value[])?.[0] ?? fn[0] ?? '') : '',
    unit, parts, warnings, turned,
    bbox: [Math.min(...bx.map((b) => b[0])), Math.min(...bx.map((b) => b[1])), Math.max(...bx.map((b) => b[2])), Math.max(...bx.map((b) => b[3]))],
    thickness: Math.max(...parts.map((p) => p.thickness)),
  };
}

/** How a solid is read: file points (already in mm) and directions into the frame its faces are analysed in. */
export interface SolidFrame {
  point: (p: V3) => V3;
  dir: (d: V3) => V3;
}

/**
 * Reads solids into parts, with their thickness along Z of the given frame:
 * every face, the 2.5D analysis (outline, holes, pockets, top and bottom
 * faces) and a mesh, all in that frame. Throws a StepError for a solid it
 * can't read as a board.
 */
export function solidParts(f: StepFile, ids: number[], o: { chordTol: number; zTol: number; mmPer: number } & SolidFrame, warnings: string[]): Part[] {
  const { chordTol, zTol, mmPer } = o;
  const turn = o.point, turnDir = o.dir;
  const E = f.entities;
  const ent = (v: Value, ctx: string): Entity => {
    if (!(v instanceof Ref)) throw new StepError(`${ctx}: expected a reference`);
    const e = E.get(v.id);
    if (!e) throw new StepError(`${ctx}: #${v.id} is missing from the file`);
    return e;
  };
  const num = (v: Value) => (v instanceof Typed ? Number(v.args[0]) : Number(v));
  const bool = (v: Value) => v instanceof Enum && v.v === 'T';

  // ---- cached geometry lookups
  const ptCache = new Map<number, V3>();
  const point = (v: Value): V3 => {
    const e = ent(v, 'point');
    let p = ptCache.get(e.id);
    if (!p) {
      if (e.type !== 'CARTESIAN_POINT') throw new StepError(`expected CARTESIAN_POINT, got ${e.type} (#${e.id})`);
      const c = e.args[1] as number[];
      p = turn([c[0] * mmPer, c[1] * mmPer, (c[2] ?? 0) * mmPer]);
      ptCache.set(e.id, p);
    }
    return p;
  };
  const direction = (v: Value): V3 => {
    const e = ent(v, 'direction');
    if (e.type !== 'DIRECTION') throw new StepError(`expected DIRECTION, got ${e.type} (#${e.id})`);
    const c = e.args[1] as number[];
    return norm(turnDir([c[0], c[1], c[2] ?? 0]));
  };
  interface Frame { o: V3; x: V3; y: V3; z: V3 }
  const frame = (v: Value): Frame => {
    const e = ent(v, 'placement');
    if (e.type !== 'AXIS2_PLACEMENT_3D') throw new StepError(`unsupported placement ${e.type} (#${e.id})`);
    const o = point(e.args[1]);
    const z = e.args[2] ? direction(e.args[2]) : [0, 0, 1] as V3;
    let x: V3 = e.args[3] ? direction(e.args[3]) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = norm(sub(x, scale(z, dot(x, z))));            // make orthogonal
    return { o, x, y: cross(z, x), z };
  };
  const vertex = (v: Value): V3 => {
    const e = ent(v, 'vertex');
    if (e.type !== 'VERTEX_POINT') throw new StepError(`unsupported vertex ${e.type} (#${e.id})`);
    return point(e.args[1]);
  };

  // ---- B-spline curves and surfaces (plain or rational, simple or complex entities)
  const nums = (v: Value) => (v as Value[]).map((x) => num(x));
  const splineCurve = (c: Entity): Curve | null => {
    let deg: Value, ctrl: Value, mults: Value, knots: Value, w: Value | null = null;
    if (c.type === 'B_SPLINE_CURVE_WITH_KNOTS') { [, deg, ctrl, , , , mults, knots] = c.args; }
    else if (c.parts?.B_SPLINE_CURVE && c.parts.B_SPLINE_CURVE_WITH_KNOTS) {
      [deg, ctrl] = c.parts.B_SPLINE_CURVE; [mults, knots] = c.parts.B_SPLINE_CURVE_WITH_KNOTS;
      w = c.parts.RATIONAL_B_SPLINE_CURVE?.[0] ?? null;
    } else return null;
    return { p: num(deg), P: (ctrl as Value[]).map(point), U: expandKnots(nums(mults), nums(knots)), W: w ? nums(w) : null };
  };
  const splineSurface = (e: Entity): Surface | null => {
    let pu: Value, pv: Value, grid: Value, um: Value, vm: Value, uk: Value, vk: Value, w: Value | null = null;
    if (e.type === 'B_SPLINE_SURFACE_WITH_KNOTS') { [, pu, pv, grid, , , , , um, vm, uk, vk] = e.args; }
    else if (e.parts?.B_SPLINE_SURFACE && e.parts.B_SPLINE_SURFACE_WITH_KNOTS) {
      [pu, pv, grid] = e.parts.B_SPLINE_SURFACE; [um, vm, uk, vk] = e.parts.B_SPLINE_SURFACE_WITH_KNOTS;
      w = e.parts.RATIONAL_B_SPLINE_SURFACE?.[0] ?? null;
    } else return null;
    return {
      pu: num(pu), pv: num(pv), P: (grid as Value[][]).map((row) => row.map(point)),
      U: expandKnots(nums(um), nums(uk)), V: expandKnots(nums(vm), nums(vk)),
      W: w ? (w as Value[][]).map((row) => nums(row)) : null,
    };
  };
  const curveName = (c: Entity) => (c.parts ? Object.keys(c.parts).filter((k) => k.includes('CURVE')).join(' + ') || c.type : c.type);

  // ---- edges: sampled once each, in the edge's own direction (v1 -> v2)
  const edgeCache = new Map<number, V3[]>();
  const segs = (r: number, ang: number) => {
    const step = r > chordTol ? 2 * Math.acos(Math.max(-1, 1 - chordTol / r)) : Math.PI / 8;
    return Math.max(2, Math.ceil(Math.abs(ang) / Math.min(step, Math.PI / 8)));
  };
  const edgePoints = (v: Value): V3[] => {
    const e = ent(v, 'edge');
    const hit = edgeCache.get(e.id);
    if (hit) return hit;
    if (e.type !== 'EDGE_CURVE') throw new StepError(`unsupported edge ${e.type} (#${e.id})`);
    const a = vertex(e.args[1]), b = vertex(e.args[2]);
    const sense = bool(e.args[4]);
    let c = ent(e.args[3], 'curve');
    // curves on surfaces carry the 3D curve first
    while (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE' || c.type === 'INTERSECTION_CURVE') c = ent(c.args[1], 'curve');
    let pts: V3[];
    const sp = splineCurve(c);
    if (c.type === 'LINE') pts = [a, b];
    else if (c.type === 'CIRCLE' || c.type === 'ELLIPSE') {
      const F = frame(c.args[1]);
      const r1 = num(c.args[2]) * mmPer, r2 = c.type === 'ELLIPSE' ? num(c.args[3]) * mmPer : r1;
      const ang = (p: V3) => { const d = sub(p, F.o); return Math.atan2(dot(d, F.y) / r2, dot(d, F.x) / r1); };
      const t0 = ang(a);
      let t1 = ang(b);
      const closed = Math.hypot(...sub(a, b)) < 1e-6;
      if (sense) { while (t1 <= t0 + (closed ? 1e-9 : 0)) t1 += 2 * Math.PI; if (!closed && t1 - t0 > 2 * Math.PI) t1 -= 2 * Math.PI; }
      else { while (t1 >= t0 - (closed ? 1e-9 : 0)) t1 -= 2 * Math.PI; if (!closed && t0 - t1 > 2 * Math.PI) t1 += 2 * Math.PI; }
      const n = segs(Math.max(r1, r2), t1 - t0);
      pts = [];
      for (let k = 0; k <= n; k++) {
        const t = t0 + (t1 - t0) * (k / n);
        pts.push(add(F.o, add(scale(F.x, r1 * Math.cos(t)), scale(F.y, r2 * Math.sin(t)))));
      }
      pts[0] = a; pts[n] = b;                            // exact end points so loops close
    } else if (sp || c.type === 'POLYLINE') {
      // a spline (or polyline): sample the whole curve, then keep the stretch from a to b
      let S: V3[];
      if (sp) S = sampleCurve(sp, chordTol).pts;
      else S = (c.args[1] as Value[]).map(point);
      const near = (q: V3) => { let k = 0, d = Infinity; S.forEach((p, i) => { const e2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (e2 < d) { d = e2; k = i; } }); return k; };
      const closedCurve = Math.hypot(...sub(S[0], S[S.length - 1])) < 1e-6;
      const ia = near(a), ib = near(b);
      const step = sense ? 1 : -1, n = S.length - (closedCurve ? 1 : 0);
      const same = Math.hypot(...sub(a, b)) < 1e-6;
      pts = [a];
      if (closedCurve) {
        // walk round the loop (all the way when the edge starts and ends at the same vertex)
        let k = ia, guard = 0;
        do { k = (k + step + n) % n; if (k !== ib || same) pts.push(S[k]); } while ((k !== ib || (same && guard === 0)) && guard++ < n + 1);
      } else {
        for (let k = ia + step; sense ? k < ib : k > ib; k += step) pts.push(S[k]);
      }
      pts.push(b);
    } else {
      throw new StepError(`Curve type ${curveName(c)} is not supported yet (#${c.id}). Supported: ${[...SUPPORTED_CURVES].join(', ')}.`);
    }
    edgeCache.set(e.id, pts);
    return pts;
  };

  const loopPoints = (v: Value): V3[] => {
    const lp = ent(v, 'loop');
    if (lp.type === 'VERTEX_LOOP') return [vertex(lp.args[1])];
    if (lp.type !== 'EDGE_LOOP') throw new StepError(`unsupported loop ${lp.type} (#${lp.id})`);
    const out: V3[] = [];
    for (const oe of lp.args[1] as Value[]) {
      const o = ent(oe, 'oriented edge');
      if (o.type !== 'ORIENTED_EDGE') throw new StepError(`unsupported loop member ${o.type} (#${o.id})`);
      let p = edgePoints(o.args[3]);
      if (!bool(o.args[4])) p = [...p].reverse();
      for (let k = out.length ? 1 : 0; k < p.length; k++) out.push(p[k]);
    }
    if (out.length > 1 && Math.hypot(...sub(out[0], out[out.length - 1])) < 1e-6) out.pop();
    return out;
  };

  // ---- faces
  interface Face {
    id: number; kind: 'plane' | 'cylinder' | 'cone' | 'spline' | 'other';
    loops: V3[][]; outer: number;   // index of the outer loop
    n?: V3;                          // plane normal (oriented)
    nz: number;                      // representative normal z (sign tells up/down)
    z: number;                       // plane z (horizontal planes)
    flat: boolean;                   // horizontal plane
    surf: { F: Frame; r?: number; ang?: number; sign: number; S?: Surface };
  }
  // Mean normal z over a face's boundary points: a side face that leans up
  // (a rounded-over top edge) counts towards the footprint, one that faces
  // sideways (a hole drilled into the edge) doesn't.
  const meanNz = (loops: V3[][], normalAt: (p: V3) => V3) => {
    const pts = loops.flat();
    const nz = pts.reduce((sum, p) => sum + normalAt(p)[2], 0) / Math.max(1, pts.length);
    return Math.abs(nz) < 0.02 ? 0 : nz;
  };
  const face = (e: Entity): Face => {
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') throw new StepError(`unsupported face ${e.type} (#${e.id})`);
    const s = ent(e.args[2], 'surface');
    const sp = splineSurface(s);
    if (sp) return splineFace(e, sp);
    const sign = bool(e.args[3]) ? 1 : -1;
    if (!SUPPORTED_SURFACES.has(s.type)) return otherFace(e, s, sign);
    const F = frame(s.args[1]);
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      const pts = loopPoints(b.args[1]);
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(pts);
    }
    const all = loops.flat();
    const zs = all.map((p) => p[2]);
    const flatZ = Math.max(...zs) - Math.min(...zs) < zTol;
    if (outer < 0 && loops.length > 1) {
      // only FACE_BOUNDs (allowed by the standard): the outer loop is the one
      // enclosing the largest area, measured in the face's own plane
      const ax: V3 = Math.abs(F.z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = norm(cross(ax, F.z)), w = cross(F.z, u);
      const areaOf = (l: V3[]) => Math.abs(ringArea(l.map((p) => [dot(p, u), dot(p, w)] as Pt)));
      if (s.type === 'PLANE') loops.forEach((l, k) => { if (outer < 0 || areaOf(l) > areaOf(loops[outer])) outer = k; });
    }
    if (s.type === 'PLANE') {
      const n = scale(F.z, sign);
      return { id: e.id, kind: 'plane', loops, outer, n, nz: n[2], z: zs.reduce((a, b) => a + b, 0) / zs.length, flat: Math.abs(n[2]) > 0.999 && flatZ, surf: { F, sign } };
    }
    const r = num(s.args[2]) * mmPer;
    const ang = s.type === 'CONICAL_SURFACE' ? num(s.args[3]) : 0; // semi-angle (radians in plane-angle unit)
    if (Math.abs(F.z[2]) < 0.999) {
      // Not straight through the board (a hole into an edge, a rounded-over edge): a side face.
      const normalAt = (p: V3): V3 => {
        const d = sub(p, F.o);
        const radial = norm(sub(d, scale(F.z, dot(d, F.z))));
        return scale(ang ? norm(sub(radial, scale(F.z, Math.tan(ang)))) : radial, sign);
      };
      return { id: e.id, kind: ang ? 'cone' : 'cylinder', loops, outer, nz: meanNz(loops, normalAt), z: 0, flat: false, surf: { F, r, ang: ang || undefined, sign } };
    }
    if (s.type === 'CYLINDRICAL_SURFACE') return { id: e.id, kind: 'cylinder', loops, outer, nz: 0, z: 0, flat: false, surf: { F, r, sign } };
    // outward normal of a cone at u=0: x - tan(a) * axis
    const nz = dot(norm(sub(F.x, scale(F.z, Math.tan(ang)))), [0, 0, 1]) * sign;
    return { id: e.id, kind: 'cone', loops, outer, nz, z: 0, flat: false, surf: { F, r, ang, sign } };
  };

  /** Tori, spheres and other surfaces (rounded corners, hardware): side faces, no mesh yet. */
  const otherFace = (e: Entity, s: Entity, sign: number): Face => {
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(loopPoints(b.args[1]));
    }
    const F = s.args[1] instanceof Ref && E.get(s.args[1].id)?.type === 'AXIS2_PLACEMENT_3D' ? frame(s.args[1]) : null;
    let normalAt: ((p: V3) => V3) | null = null;
    if (F && s.type === 'SPHERICAL_SURFACE') normalAt = (p) => scale(norm(sub(p, F.o)), sign);
    if (F && s.type === 'TOROIDAL_SURFACE') {
      const R = num(s.args[2]) * mmPer;
      normalAt = (p) => {
        const d = sub(p, F.o);
        const ring = add(F.o, scale(norm(sub(d, scale(F.z, dot(d, F.z)))), R));
        return scale(norm(sub(p, ring)), sign);
      };
    }
    if (!normalAt) warnings.push(`Surface type ${s.parts ? Object.keys(s.parts).join(' + ') : s.type} (face #${e.id}) is read as a side face.`);
    return { id: e.id, kind: 'other', loops, outer, nz: normalAt ? meanNz(loops, normalAt) : 0, z: 0, flat: false, surf: { F: F ?? { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, sign } };
  };

  /** A B-spline face: a side wall straight through the board, or a flat face. */
  const splineFace = (e: Entity, S: Surface): Face => {
    const sign = bool(e.args[3]) ? 1 : -1;
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(loopPoints(b.args[1]));
    }
    const [u0, u1, v0, v1] = surfaceDomain(S);
    let minNz = 1, maxNz = -1, sumNz = 0, n0: V3 = [0, 0, 1];
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
      const n = surfaceNormal(S, u0 + ((u1 - u0) * i) / 6, v0 + ((v1 - v0) * j) / 6);
      minNz = Math.min(minNz, n[2] * sign); maxNz = Math.max(maxNz, n[2] * sign); sumNz += n[2] * sign;
      if (i === 3 && j === 3) n0 = scale(n, sign);
    }
    const zs = loops.flat().map((p) => p[2]);
    const flatZ = Math.max(...zs) - Math.min(...zs) < zTol;
    const F: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    if (flatZ && Math.abs(minNz) > 0.999 && Math.sign(minNz) === Math.sign(maxNz)) {
      const n: V3 = [0, 0, Math.sign(minNz)];
      if (outer < 0) loops.forEach((l, k) => { if (outer < 0 || Math.abs(ringArea(l.map((p) => [p[0], p[1]] as Pt))) > Math.abs(ringArea(loops[outer].map((p) => [p[0], p[1]] as Pt)))) outer = k; });
      return { id: e.id, kind: 'plane', loops, outer, n, nz: n[2], z: zs.reduce((a, b) => a + b, 0) / zs.length, flat: true, surf: { F, sign } };
    }
    if (Math.max(Math.abs(minNz), Math.abs(maxNz)) > 0.02) {
      warnings.push(`A curved face that is neither flat nor vertical was found (face #${e.id}); it is read as a side wall, so the part may come out slightly wrong.`);
    }
    return { id: e.id, kind: 'spline', loops, outer, n: n0, nz: Math.abs(sumNz / 49) < 0.02 ? 0 : sumNz / 49, z: 0, flat: false, surf: { F, sign, S } };
  };

  const proj = (loop: V3[]): Ring => loop.map((p) => [p[0], p[1]] as Pt);
  const facePoly = (fc: Face): Poly => {
    const rings = fc.loops.map(proj).filter((r) => r.length >= 3);
    if (!rings.length) return [];
    let oi = fc.outer >= 0 ? fc.outer : 0;
    if (fc.outer < 0) rings.forEach((r, k) => { if (Math.abs(ringArea(r)) > Math.abs(ringArea(rings[oi]))) oi = k; });
    return [rings[oi], ...rings.filter((_, k) => k !== oi)];
  };

  // ---- tessellation for the 3D view
  const meshFace = (fc: Face, P: number[], N: number[], I: number[]) => {
    if (fc.kind === 'other') return; // no tessellation for these yet
    const base = P.length / 3;
    if (fc.kind === 'plane') {
      const n = fc.n!;
      const ax: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = norm(cross(ax, n)), w = cross(n, u);
      const flat: number[] = [], holes: number[] = [], verts: V3[] = [];
      const order = fc.outer >= 0 ? [fc.outer, ...fc.loops.map((_, k) => k).filter((k) => k !== fc.outer)] : fc.loops.map((_, k) => k);
      order.forEach((li, k) => {
        if (k > 0) holes.push(verts.length);
        for (const p of fc.loops[li]) { verts.push(p); flat.push(dot(p, u), dot(p, w)); }
      });
      const tri = earcut(flat, holes.length ? holes : undefined, 2);
      for (const p of verts) { P.push(...p); N.push(...n); }
      // earcut winding follows the input; make every triangle face along n
      for (let k = 0; k < tri.length; k += 3) {
        const a = verts[tri[k]], b = verts[tri[k + 1]], c = verts[tri[k + 2]];
        const ok = dot(cross(sub(b, a), sub(c, a)), n) >= 0;
        I.push(base + tri[k], base + (ok ? tri[k + 1] : tri[k + 2]), base + (ok ? tri[k + 2] : tri[k + 1]));
      }
      return;
    }
    if (fc.kind === 'spline') {
      // the surface itself on a grid (side walls of extruded curves fill their whole surface)
      const S = fc.surf.S!, sign = fc.surf.sign;
      const [u0, u1, v0, v1] = surfaceDomain(S);
      const spans = (K: number[], a: number, b: number) => new Set(K.filter((k) => k > a && k < b)).size + 1;
      const nu = Math.min(400, spans(S.U, u0, u1) * (S.pu > 1 ? 8 : 1)), nv = Math.min(400, spans(S.V, v0, v1) * (S.pv > 1 ? 8 : 1));
      for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
        const u = u0 + ((u1 - u0) * i) / nu, v = v0 + ((v1 - v0) * j) / nv;
        P.push(...surfaceAt(S, u, v)); N.push(...scale(surfaceNormal(S, u, v), sign));
      }
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const a = base + i * (nv + 1) + j, b = a + nv + 1, c = a + 1, d = b + 1;
        if (sign > 0) I.push(a, b, d, a, d, c); else I.push(a, d, b, a, c, d);
      }
      return;
    }
    // cylinder / cone: unwrap to (angle, height) and triangulate there
    const { F, sign } = fc.surf;
    const uv = (p: V3): [number, number] => { const d = sub(p, F.o); return [Math.atan2(dot(d, F.y), dot(d, F.x)), dot(d, F.z)]; };
    const normalAt = (p: V3): V3 => {
      const d = sub(p, F.o);
      const radial = norm(sub(d, scale(F.z, dot(d, F.z))));
      const n = fc.kind === 'cone' ? norm(sub(radial, scale(F.z, Math.tan(fc.surf.ang!)))) : radial;
      return scale(n, sign);
    };
    const closedCircle = (lp: V3[]) => {
      const a = lp.map((p) => uv(p)[0]);
      let s = 0;
      for (let k = 0; k < a.length; k++) { let d = a[(k + 1) % a.length] - a[k]; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; s += d; }
      return Math.abs(s) > Math.PI;                     // winds around the axis
    };
    if (fc.loops.length === 2 && closedCircle(fc.loops[0]) && closedCircle(fc.loops[1])) {
      // full band between two circles: resample both rings at the same angles
      const [l0, l1] = fc.loops;
      const v0 = uv(l0[0])[1], v1 = uv(l1[0])[1];
      const r0 = Math.hypot(...sub(sub(l0[0], F.o), scale(F.z, v0)));
      const r1 = Math.hypot(...sub(sub(l1[0], F.o), scale(F.z, v1)));
      const n = segs(Math.max(r0, r1), 2 * Math.PI);
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * 2 * Math.PI;
        const dir = add(scale(F.x, Math.cos(t)), scale(F.y, Math.sin(t)));
        const pa = add(add(F.o, scale(F.z, v0)), scale(dir, r0));
        const pb = add(add(F.o, scale(F.z, v1)), scale(dir, r1));
        P.push(...pa, ...pb); N.push(...normalAt(pa), ...normalAt(pb));
      }
      for (let k = 0; k < n; k++) {
        const a = base + 2 * k, b = a + 1, c = a + 2, d = a + 3;
        const nrm = normalAt([P[a * 3], P[a * 3 + 1], P[a * 3 + 2]]);
        const pa: V3 = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], pb: V3 = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pc: V3 = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
        const ok = dot(cross(sub(pb, pa), sub(pc, pa)), nrm) >= 0;
        if (ok) I.push(a, b, c, b, d, c); else I.push(a, c, b, b, c, d);
      }
      return;
    }
    // partial face (e.g. an arc wall between two straight edges): unwrap each loop
    // to (angle, height), cut the region into strips at every boundary angle and
    // emit one quad per strip, mapped back onto the true surface.
    const uvLoops: [number, number][][] = fc.loops.map((lp) => {
      let prev: number | null = null, off = 0;
      return lp.map((p) => {
        let [u, v] = uv(p);
        if (prev !== null) { while (u + off - prev > Math.PI) off -= 2 * Math.PI; while (u + off - prev < -Math.PI) off += 2 * Math.PI; }
        u += off; prev = u;
        return [u, v] as [number, number];
      });
    });
    // bring every loop into the same angle range as the first one
    const u0 = uvLoops[0][0][0];
    for (const l of uvLoops.slice(1)) { const d = Math.round((l[0][0] - u0) / (2 * Math.PI)) * 2 * Math.PI; for (const q of l) q[0] -= d; }
    const edges: [number, number, number, number][] = [];
    for (const l of uvLoops) for (let k = 0; k < l.length; k++) { const a = l[k], c = l[(k + 1) % l.length]; if (Math.abs(c[0] - a[0]) > 1e-9) edges.push([a[0], a[1], c[0], c[1]]); }
    const us = [...new Set(uvLoops.flat().map((q) => Math.round(q[0] * 1e7) / 1e7))].sort((x, y) => x - y);
    const radiusAt = (v: number) => (fc.kind === 'cone' ? fc.surf.r! + v * Math.tan(fc.surf.ang!) : fc.surf.r!);
    const at = (u: number, v: number): V3 => add(add(F.o, scale(F.z, v)), scale(add(scale(F.x, Math.cos(u)), scale(F.y, Math.sin(u))), radiusAt(v)));
    const vOn = (e: [number, number, number, number], u: number) => e[1] + ((u - e[0]) / (e[2] - e[0])) * (e[3] - e[1]);
    for (let k = 0; k + 1 < us.length; k++) {
      const ua = us[k], ub = us[k + 1], um = (ua + ub) / 2;
      const cross = edges.filter((e) => (e[0] - um) * (e[2] - um) < 0).sort((e1, e2) => vOn(e1, um) - vOn(e2, um));
      for (let j = 0; j + 1 < cross.length; j += 2) {
        const lo = cross[j], hi = cross[j + 1];
        const q = [at(ua, vOn(lo, ua)), at(ub, vOn(lo, ub)), at(ub, vOn(hi, ub)), at(ua, vOn(hi, ua))];
        const bi = P.length / 3;
        for (const pt of q) { P.push(...pt); N.push(...normalAt(pt)); }
        const n0 = normalAt(q[0]);
        const ok = dot(cross3(sub(q[1], q[0]), sub(q[2], q[0])), n0) >= 0;
        if (ok) I.push(bi, bi + 1, bi + 2, bi, bi + 2, bi + 3); else I.push(bi, bi + 2, bi + 1, bi, bi + 3, bi + 2);
      }
    }
  };

  // ---- solids
  const solids: { name: string; faces: Face[] }[] = [];
  for (const id of ids) {
    const b = E.get(id)!;
    const shell = ent(b.args[1], 'shell');
    const faces = (shell.args[1] as Value[]).map((fv) => face(ent(fv, 'face')));
    solids.push({ name: typeof b.args[0] === 'string' && b.args[0] ? b.args[0] : `Body ${solids.length + 1}`, faces });
  }

  // ---- 2D geometry per solid
  const parts: Part[] = solids.map((s, index) => {
    const allZ = s.faces.flatMap((fc) => fc.loops.flat().map((p) => p[2]));
    const zmin = Math.min(...allZ), zmax = Math.max(...allZ);
    const up = s.faces.filter((fc) => fc.nz > 1e-6);
    const flatUp = up.filter((fc) => fc.flat);
    const flatDn = s.faces.filter((fc) => fc.flat && fc.nz < -1e-6);
    const tidy = (ps: Poly[], minArea = 1) => simplify(union(ps, minArea), 0.003).map(round3);

    // footprint: every face that looks up (also cones and chamfers)
    const sil = tidy(up.map(facePoly));
    const main = sil.reduce<Poly | null>((m, p) => (!m || ringArea(p[0]) > ringArea(m[0]) ? p : m), null);
    if (!main) throw new StepError(`Part "${s.name}" has no faces that look up; is it a closed solid?`);
    if (sil.length > 1) warnings.push(`Part "${s.name}" has ${sil.length - 1} separate piece(s) besides the main one; only the largest is used as its outline.`);

    const levels = (faces: Face[], fromTop: boolean): PocketLevel[] => {
      const zs = groupZ(faces.map((fc) => fc.z)).sort((a, b) => (fromTop ? b - a : a - b));
      const out: PocketLevel[] = [];
      for (const z of zs) {
        const sel = faces.filter((fc) => (fromTop ? fc.z <= z + zTol / 2 : fc.z >= z - zTol / 2));
        for (const p of tidy(sel.map(facePoly))) {
          out.push({ z: Math.round(z * 1000) / 1000, depth: Math.round((fromTop ? zmax - z : z - zmin) * 1000) / 1000,
            area: Math.round(Math.abs(ringArea(p[0]) + p.slice(1).reduce((a, r) => a + ringArea(r), 0)) * 10) / 10,
            poly: p[0], holes: p.slice(1).filter((r) => Math.abs(ringArea(r)) > 0.5), from: fromTop ? 'top' : 'bottom' });
        }
      }
      return out;
    };
    const pockets = [
      ...levels(flatUp.filter((fc) => fc.z < zmax - zTol), true),
      ...levels(flatDn.filter((fc) => fc.z > zmin + zTol), false),
    ];
    const topFaces = tidy(flatUp.filter((fc) => fc.z > zmax - zTol).map(facePoly));
    const bottomFaces = tidy(flatDn.filter((fc) => fc.z < zmin + zTol).map(facePoly));

    const P: number[] = [], N: number[] = [], I: number[] = [];
    for (const fc of s.faces) meshFace(fc, P, N, I);

    const xs = main[0].map((p) => p[0]), ys = main[0].map((p) => p[1]);
    let per = 0;
    for (let k = 0; k < main[0].length; k++) {
      const a = main[0][k], b = main[0][(k + 1) % main[0].length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return {
      index, label: s.name, zmin: r3(zmin), zmax: r3(zmax), thickness: r3(zmax - zmin),
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      outline: main[0], holes: main.slice(1).filter((r) => Math.abs(ringArea(r)) > 0.5),
      pockets, topFaces, bottomFaces,
      area: Math.round(Math.abs(ringArea(main[0])) * 10) / 10, perimeter: Math.round(per * 100) / 100,
      mesh: { pos: new Float32Array(P), nor: new Float32Array(N), idx: new Uint32Array(I) },
    };
  });

  return parts;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** distinct z levels, merging values closer than 0.005 mm */
function groupZ(zs: number[]): number[] {
  const out: number[] = [];
  for (const z of [...zs].sort((a, b) => a - b)) if (!out.length || z - out[out.length - 1] > 0.005) out.push(z);
  return out;
}
