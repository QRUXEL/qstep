// Geometry lookups for one read of a STEP file: points, directions and
// placements (in mm, in the frame the solids are read in), curves and
// surfaces, and edges and loops sampled into points. Shared by the board
// analysis (brep.ts) and the display meshes (meshes.ts).
import { Ref, Enum, Typed, StepError, type StepFile, type Value, type Entity } from './parse';
import { expandKnots, sampleCurve, type Curve, type Surface } from './nurbs';
import {
  conicCurve, coneParam, cylinderParam, extrusionParam, lineCurve, offsetParam, polylineCurve, revolutionParam,
  sphereParam, splineCurveFn, splineParam, torusParam, type CurveFn, type Frame, type Param,
} from './surface';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const SUPPORTED_CURVES = ['LINE', 'CIRCLE', 'ELLIPSE', 'B_SPLINE_CURVE', 'POLYLINE', 'TRIMMED_CURVE'];

export interface ReadFrame {
  /** max chord error when sampling arcs, mm */
  chordTol: number;
  /** largest angle one segment of an arc may cover, radians */
  maxArc?: number;
  mmPer: number;
  /** file point (in mm) → the frame the solids are read in */
  point: (p: V3) => V3;
  /** file direction → that frame */
  dir: (d: V3) => V3;
  /** unknown curves become straight lines (with a warning) instead of an error */
  lenient?: boolean;
}

/** Radians per plane-angle unit of the file (1, or π/180 for files in degrees). */
export function angleUnit(f: StepFile): number {
  for (const id of f.byType.get('PLANE_ANGLE_UNIT') || []) {
    const conv = f.entities.get(id)!.parts?.CONVERSION_BASED_UNIT;
    if (conv && typeof conv[0] === 'string' && conv[0].toUpperCase().includes('DEGREE')) return Math.PI / 180;
  }
  return 1;
}

export function geometry(f: StepFile, o: ReadFrame, warnings: string[]) {
  const { chordTol, mmPer } = o;
  const maxArc = o.maxArc ?? Math.PI / 8;
  const E = f.entities;
  const rad = angleUnit(f);
  const ent = (v: Value, ctx: string): Entity => {
    if (!(v instanceof Ref)) throw new StepError(`${ctx}: expected a reference`);
    const e = E.get(v.id);
    if (!e) throw new StepError(`${ctx}: #${v.id} is missing from the file`);
    return e;
  };
  const num = (v: Value) => (v instanceof Typed ? Number(v.args[0]) : Number(v));
  const bool = (v: Value) => v instanceof Enum && v.v === 'T';
  const warned = new Set<string>();
  const warnOnce = (msg: string) => { if (!warned.has(msg)) { warned.add(msg); warnings.push(msg); } };

  const ptCache = new Map<number, V3>();
  const point = (v: Value): V3 => {
    const e = ent(v, 'point');
    let p = ptCache.get(e.id);
    if (!p) {
      if (e.type !== 'CARTESIAN_POINT') throw new StepError(`expected CARTESIAN_POINT, got ${e.type} (#${e.id})`);
      const c = e.args[1] as number[];
      p = o.point([c[0] * mmPer, c[1] * mmPer, (c[2] ?? 0) * mmPer]);
      ptCache.set(e.id, p);
    }
    return p;
  };
  const direction = (v: Value): V3 => {
    const e = ent(v, 'direction');
    if (e.type !== 'DIRECTION') throw new StepError(`expected DIRECTION, got ${e.type} (#${e.id})`);
    const c = e.args[1] as number[];
    return norm(o.dir([c[0], c[1], c[2] ?? 0]));
  };
  /** VECTOR(name, direction, magnitude) → the vector in mm */
  const vector = (v: Value): V3 => {
    const e = ent(v, 'vector');
    if (e.type === 'DIRECTION') return direction(v);
    if (e.type !== 'VECTOR') throw new StepError(`expected VECTOR, got ${e.type} (#${e.id})`);
    return scale(direction(e.args[1]), num(e.args[2]) * mmPer);
  };
  const frame = (v: Value): Frame => {
    const e = ent(v, 'placement');
    if (e.type !== 'AXIS2_PLACEMENT_3D') throw new StepError(`unsupported placement ${e.type} (#${e.id})`);
    const p = point(e.args[1]);
    const z = e.args[2] instanceof Ref ? direction(e.args[2]) : [0, 0, 1] as V3;
    let x: V3 = e.args[3] instanceof Ref ? direction(e.args[3]) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = norm(sub(x, scale(z, dot(x, z))));            // make orthogonal
    return { o: p, x, y: cross(z, x), z };
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
    } else if (c.parts?.B_SPLINE_CURVE && c.parts.BEZIER_CURVE) {
      [deg, ctrl] = c.parts.B_SPLINE_CURVE;
      const p = num(deg), n = (ctrl as Value[]).length;
      return { p, P: (ctrl as Value[]).map(point), U: [...Array(p + 1).fill(0), ...Array(n - p - 1).fill(0).map((_, k) => (k + 1) / (n - p)), ...Array(p + 1).fill(1)], W: c.parts.RATIONAL_B_SPLINE_CURVE ? nums(c.parts.RATIONAL_B_SPLINE_CURVE[0]) : null };
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
  const surfaceName = (s: Entity) => (s.parts ? Object.keys(s.parts).join(' + ') : s.type);

  /** A curve as a function of its parameter (for swept surfaces), or null. */
  const curveFn = (c: Entity): CurveFn | null => {
    while (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE' || c.type === 'INTERSECTION_CURVE') c = ent(c.args[1], 'curve');
    if (c.type === 'TRIMMED_CURVE') return curveFn(ent(c.args[1], 'curve'));
    if (c.type === 'LINE') return lineCurve(point(c.args[1]), vector(c.args[2]));
    if (c.type === 'CIRCLE') { const r = num(c.args[2]) * mmPer; return conicCurve(frame(c.args[1]), r, r); }
    if (c.type === 'ELLIPSE') return conicCurve(frame(c.args[1]), num(c.args[2]) * mmPer, num(c.args[3]) * mmPer);
    if (c.type === 'POLYLINE') return polylineCurve((c.args[1] as Value[]).map(point));
    const sp = splineCurve(c);
    return sp ? splineCurveFn(sp) : null;
  };

  // ---- edges: sampled once each, in the edge's own direction (v1 -> v2)
  const edgeCache = new Map<number, V3[]>();
  const segs = (r: number, ang: number) => {
    const step = r > chordTol ? 2 * Math.acos(Math.max(-1, 1 - chordTol / r)) : Math.PI / 8;
    return Math.max(2, Math.ceil(Math.abs(ang) / Math.min(step, maxArc)));
  };
  const edgePoints = (v: Value): V3[] => {
    const e = ent(v, 'edge');
    const hit = edgeCache.get(e.id);
    if (hit) return hit;
    if (e.type !== 'EDGE_CURVE') throw new StepError(`unsupported edge ${e.type} (#${e.id})`);
    const a = vertex(e.args[1]), b = vertex(e.args[2]);
    const sense = bool(e.args[4]);
    let c = ent(e.args[3], 'curve');
    // curves on surfaces carry the 3D curve first; a trimmed curve's ends are the edge's vertices
    while (c.type === 'SURFACE_CURVE' || c.type === 'SEAM_CURVE' || c.type === 'INTERSECTION_CURVE' || c.type === 'TRIMMED_CURVE') c = ent(c.args[1], 'curve');
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
    } else if (o.lenient) {
      warnOnce(`Curve type ${curveName(c)} is not supported yet; such edges are drawn straight.`);
      pts = [a, b];
    } else {
      throw new StepError(`Curve type ${curveName(c)} is not supported yet (#${c.id}). Supported: ${SUPPORTED_CURVES.join(', ')}.`);
    }
    edgeCache.set(e.id, pts);
    return pts;
  };

  const loopPoints = (v: Value): V3[] => {
    const lp = ent(v, 'loop');
    if (lp.type === 'VERTEX_LOOP') return [vertex(lp.args[1])];
    if (lp.type === 'POLY_LOOP') return (lp.args[1] as Value[]).map(point);
    if (lp.type !== 'EDGE_LOOP') throw new StepError(`unsupported loop ${lp.type} (#${lp.id})`);
    const out: V3[] = [];
    for (const oe of lp.args[1] as Value[]) {
      const oo = ent(oe, 'oriented edge');
      if (oo.type !== 'ORIENTED_EDGE') throw new StepError(`unsupported loop member ${oo.type} (#${oo.id})`);
      let p = edgePoints(oo.args[3]);
      if (!bool(oo.args[4])) p = [...p].reverse();
      for (let k = out.length ? 1 : 0; k < p.length; k++) out.push(p[k]);
    }
    if (out.length > 1 && Math.hypot(...sub(out[0], out[out.length - 1])) < 1e-6) out.pop();
    return out;
  };

  /** A face's loops, each oriented as the face uses it, and which one is the outer bound (−1: not marked). */
  const faceLoops = (e: Entity): { loops: V3[][]; outer: number } => {
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      let pts = loopPoints(b.args[1]);
      // a bound used against its loop's direction
      if (b.args[2] instanceof Enum && b.args[2].v === 'F') pts = [...pts].reverse();
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(pts);
    }
    return { loops, outer };
  };

  /**
   * The parametric form of a surface for meshing, with its plane angle unit and
   * the face's points (which bound the parameter search of swept lines). Null
   * for planes (meshed flat) and for surfaces not read yet.
   */
  const surfaceParam = (s: Entity, around: V3[]): Param | null => {
    const sp = splineSurface(s);
    if (sp) return splineParam(sp);
    switch (s.type) {
      case 'CYLINDRICAL_SURFACE': return cylinderParam(frame(s.args[1]), num(s.args[2]) * mmPer);
      case 'CONICAL_SURFACE': return coneParam(frame(s.args[1]), num(s.args[2]) * mmPer, num(s.args[3]) * rad);
      case 'SPHERICAL_SURFACE': return sphereParam(frame(s.args[1]), num(s.args[2]) * mmPer);
      case 'TOROIDAL_SURFACE': case 'DEGENERATE_TOROIDAL_SURFACE':
        return torusParam(frame(s.args[1]), num(s.args[2]) * mmPer, num(s.args[3]) * mmPer);
      case 'RECTANGULAR_TRIMMED_SURFACE': case 'CURVE_BOUNDED_SURFACE':
        return surfaceParam(ent(s.args[1], 'surface'), around);
      case 'OFFSET_SURFACE': {
        const basis = ent(s.args[1], 'surface');
        const B = basis.type === 'PLANE' ? null : surfaceParam(basis, around);
        return B ? offsetParam(B, num(s.args[2]) * mmPer) : null;
      }
      case 'SURFACE_OF_LINEAR_EXTRUSION': {
        const C = curveFn(ent(s.args[1], 'curve'));
        if (!C) return null;
        return extrusionParam(C, vector(s.args[2]), curveRange(C, around));
      }
      case 'SURFACE_OF_REVOLUTION': {
        const C = curveFn(ent(s.args[1], 'curve'));
        const ax = ent(s.args[2], 'axis');
        if (!C || ax.type !== 'AXIS1_PLACEMENT') return null;
        const A = point(ax.args[1]), D = ax.args[2] instanceof Ref ? direction(ax.args[2]) : [0, 0, 1] as V3;
        // a line profile's range: the face's points turned into the profile's half-plane
        let inPlane = around;
        if (!Number.isFinite(C.t0)) {
          const q0 = sub(C.at(0), A), q1 = sub(C.at(1), A);
          let ref = sub(q0, scale(D, dot(q0, D)));
          if (Math.hypot(...ref) < 1e-9) ref = sub(q1, scale(D, dot(q1, D)));
          ref = norm(ref);
          inPlane = around.map((p) => { const w = sub(p, A), h = dot(w, D); return add(A, add(scale(D, h), scale(ref, Math.hypot(...sub(w, scale(D, h)))))); });
        }
        return revolutionParam(C, A, D, curveRange(C, inPlane));
      }
    }
    return null;
  };
  /** The parameter range of a curve that covers a face's points (lines are infinite). */
  const curveRange = (C: CurveFn, around: V3[]): [number, number] => {
    if (Number.isFinite(C.t0) && Number.isFinite(C.t1)) return [C.t0, C.t1];
    // a line: project the points onto it
    const p0 = C.at(0), d = sub(C.at(1), p0), dd = dot(d, d) || 1;
    let lo = Infinity, hi = -Infinity;
    for (const p of around) { const t = dot(sub(p, p0), d) / dd; lo = Math.min(lo, t); hi = Math.max(hi, t); }
    const pad = (hi - lo) * 0.05 + 1e-6;
    return Number.isFinite(lo) ? [lo - pad, hi + pad] : [-1, 1];
  };

  return { E, ent, num, bool, point, direction, vector, frame, vertex, splineCurve, splineSurface, curveName, surfaceName, curveFn, edgePoints, loopPoints, faceLoops, surfaceParam, segs, warnOnce };
}

export type Geometry = ReturnType<typeof geometry>;
