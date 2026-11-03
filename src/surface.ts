// Surfaces and curves as parametric functions, for meshing in a face's own (u, v)
// space: evaluation, the inverse (a point on the surface → its u, v) and the
// periods of closed directions. Lengths are in mm in the solid's frame.
//
// Every surface's natural normal is dS/du × dS/dv of the parameterisation used
// here, and matches the STEP surface normal: outward for cylinders, cones,
// spheres and tori, the defining parameterisation for the rest.
import { curveAt, curveDomain, surfaceAt, surfaceDomain, type Curve, type Surface } from './nurbs';

import type { V3 } from './assembly';
export type { V3 };
export type UV = [number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const TAU = 2 * Math.PI;

export interface Frame { o: V3; x: V3; y: V3; z: V3 }

// ---------------------------------------------------------------- curves

export interface CurveFn {
  at(t: number): V3;
  /** parameter range; infinite for lines */
  t0: number; t1: number;
  /** closed with this period (circles, ellipses), else 0 */
  period: number;
}

export const lineCurve = (p: V3, d: V3): CurveFn => ({ at: (t) => add(p, scale(d, t)), t0: -Infinity, t1: Infinity, period: 0 });
export const conicCurve = (F: Frame, r1: number, r2: number): CurveFn => ({
  at: (t) => add(F.o, add(scale(F.x, r1 * Math.cos(t)), scale(F.y, r2 * Math.sin(t)))), t0: 0, t1: TAU, period: TAU,
});
export const splineCurveFn = (c: Curve): CurveFn => {
  const [t0, t1] = curveDomain(c);
  return { at: (t) => curveAt(c, Math.min(t1, Math.max(t0, t))), t0, t1, period: 0 };
};
export const polylineCurve = (P: V3[]): CurveFn => ({
  at: (t) => {
    const k = Math.min(P.length - 2, Math.max(0, Math.floor(t)));
    const f = t - k;
    return add(scale(P[k], 1 - f), scale(P[k + 1], f));
  },
  t0: 0, t1: P.length - 1, period: 0,
});

/** Samples of a curve over a finite range, for nearest-point searches. */
function curveSamples(c: CurveFn, a: number, b: number, n: number): { t: number[]; p: V3[] } {
  const t: number[] = [], p: V3[] = [];
  for (let k = 0; k <= n; k++) { const s = a + ((b - a) * k) / n; t.push(s); p.push(c.at(s)); }
  return { t, p };
}

/** Golden-section refinement of a 1D minimum in [a, b]. */
function refine1(f: (t: number) => number, a: number, b: number, iters = 40): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let k = 0; k < iters; k++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

/**
 * The parameter of the curve point that minimises `cost` (a distance-like
 * function of the curve point), searched over [a, b] of a finite curve.
 */
function nearestT(c: CurveFn, cost: (q: V3) => number, a: number, b: number, n = 96, cache?: { t: number[]; p: V3[] }): number {
  const S = cache ?? curveSamples(c, a, b, n);
  let k = 0, best = Infinity;
  S.p.forEach((q, i) => { const e = cost(q); if (e < best) { best = e; k = i; } });
  const lo = S.t[Math.max(0, k - 1)], hi = S.t[Math.min(S.t.length - 1, k + 1)];
  return refine1((t) => cost(c.at(t)), lo, hi);
}

// ---------------------------------------------------------------- surfaces

export interface Param {
  at(u: number, v: number): V3;
  /** (u, v) of a point on (or near) the surface; hint: the (u, v) of a nearby point */
  inv(p: V3, hint?: UV | null): UV;
  /** period of a closed direction, 0 when open */
  uPeriod: number; vPeriod: number;
  /** open ends of the parameter range (for regions that run to a pole) */
  vMin: number; vMax: number;
}

const unwrapNear = (x: number, ref: number, period: number) => (period ? x + Math.round((ref - x) / period) * period : x);

export function cylinderParam(F: Frame, r: number): Param {
  return {
    at: (u, v) => add(add(F.o, scale(F.z, v)), scale(add(scale(F.x, Math.cos(u)), scale(F.y, Math.sin(u))), r)),
    inv: (p, hint) => { const d = sub(p, F.o); const u = Math.atan2(dot(d, F.y), dot(d, F.x)); return [hint ? unwrapNear(u, hint[0], TAU) : u, dot(d, F.z)]; },
    uPeriod: TAU, vPeriod: 0, vMin: -Infinity, vMax: Infinity,
  };
}

/** Cone with radius r at v = 0 and semi-angle a: the radius grows by tan(a) per unit of v. */
export function coneParam(F: Frame, r: number, a: number): Param {
  const t = Math.tan(a);
  // the apex (radius 0) is the end of the range on its side
  const apex = t ? -r / t : -Infinity;
  return {
    at: (u, v) => add(add(F.o, scale(F.z, v)), scale(add(scale(F.x, Math.cos(u)), scale(F.y, Math.sin(u))), r + v * t)),
    inv: (p, hint) => {
      const d = sub(p, F.o);
      const u = Math.atan2(dot(d, F.y), dot(d, F.x));
      // the axial coordinate of the nearest point on the cone's line through this angle
      const radial = Math.hypot(dot(d, F.x), dot(d, F.y)), h = dot(d, F.z);
      const v = (h + (radial - r) * t) / (1 + t * t);
      return [hint ? unwrapNear(u, hint[0], TAU) : u, v];
    },
    uPeriod: TAU, vPeriod: 0, vMin: t > 0 ? apex : -Infinity, vMax: t < 0 ? apex : Infinity,
  };
}

export function sphereParam(F: Frame, R: number): Param {
  return {
    at: (u, v) => add(F.o, add(scale(add(scale(F.x, Math.cos(u)), scale(F.y, Math.sin(u))), R * Math.cos(v)), scale(F.z, R * Math.sin(v)))),
    inv: (p, hint) => {
      const d = sub(p, F.o);
      const u = Math.atan2(dot(d, F.y), dot(d, F.x));
      const v = Math.atan2(dot(d, F.z), Math.hypot(dot(d, F.x), dot(d, F.y)));
      return [hint ? unwrapNear(u, hint[0], TAU) : u, v];
    },
    uPeriod: TAU, vPeriod: 0, vMin: -Math.PI / 2, vMax: Math.PI / 2,
  };
}

export function torusParam(F: Frame, R: number, r: number): Param {
  return {
    at: (u, v) => {
      const radial = add(scale(F.x, Math.cos(u)), scale(F.y, Math.sin(u)));
      return add(F.o, add(scale(radial, R + r * Math.cos(v)), scale(F.z, r * Math.sin(v))));
    },
    inv: (p, hint) => {
      const d = sub(p, F.o);
      const u = Math.atan2(dot(d, F.y), dot(d, F.x));
      const v = Math.atan2(dot(d, F.z), Math.hypot(dot(d, F.x), dot(d, F.y)) - R);
      return hint ? [unwrapNear(u, hint[0], TAU), unwrapNear(v, hint[1], TAU)] : [u, v];
    },
    uPeriod: TAU, vPeriod: TAU, vMin: -Infinity, vMax: Infinity,
  };
}

/**
 * Inverse by search: a coarse grid over the domain, then Gauss–Newton steps
 * from the best grid point (or from the hint, when it lands on the surface).
 */
function numericInverse(at: (u: number, v: number) => V3, dom: [number, number, number, number], uPeriod: number, vPeriod: number) {
  const [u0, u1, v0, v1] = dom;
  const N = 24;
  let grid: { u: number; v: number; p: V3 }[] | null = null;
  const hu = (u1 - u0) * 1e-6 || 1e-6, hv = (v1 - v0) * 1e-6 || 1e-6;
  const clampU = (u: number) => (uPeriod ? u : Math.min(u1, Math.max(u0, u)));
  const clampV = (v: number) => (vPeriod ? v : Math.min(v1, Math.max(v0, v)));
  const newton = (p: V3, u: number, v: number): [number, number, number] => {
    let q = at(u, v), e = dist2(q, p);
    for (let it = 0; it < 12 && e > 1e-14; it++) {
      const su = scale(sub(at(u + hu, v), at(u - hu, v)), 1 / (2 * hu));
      const sv = scale(sub(at(u, v + hv), at(u, v - hv)), 1 / (2 * hv));
      const r = sub(p, q);
      const a = dot(su, su), b = dot(su, sv), c = dot(sv, sv), du = dot(su, r), dv = dot(sv, r);
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-30)) break;
      let nu = clampU(u + (c * du - b * dv) / det), nv = clampV(v + (a * dv - b * du) / det);
      let nq = at(nu, nv), ne = dist2(nq, p);
      // halve the step while it makes things worse
      for (let h = 0; h < 8 && ne > e; h++) { nu = (u + nu) / 2; nv = (v + nv) / 2; nq = at(nu, nv); ne = dist2(nq, p); }
      if (ne >= e) break;
      u = nu; v = nv; q = nq; e = ne;
    }
    return [u, v, e];
  };
  return (p: V3, hint?: UV | null): UV => {
    if (hint) {
      const [u, v, e] = newton(p, hint[0], hint[1]);
      if (e < 1e-4) return [u, v];
    }
    if (!grid) {
      grid = [];
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
        const u = u0 + ((u1 - u0) * i) / N, v = v0 + ((v1 - v0) * j) / N;
        grid.push({ u, v, p: at(u, v) });
      }
    }
    // the few nearest grid points, each polished: the nearest one alone can sit on the wrong fold
    const near = grid.map((g) => ({ g, e: dist2(g.p, p) })).sort((a, b) => a.e - b.e).slice(0, 4);
    let best: [number, number, number] = [near[0].g.u, near[0].g.v, Infinity];
    for (const { g } of near) {
      const r = newton(p, g.u, g.v);
      if (r[2] < best[2]) best = r;
      if (r[2] < 1e-10) break;
    }
    let [u, v] = best;
    if (hint) { u = unwrapNear(u, hint[0], uPeriod); v = unwrapNear(v, hint[1], vPeriod); }
    return [u, v];
  };
}

/** Closed in u (or v) when the two ends of the range coincide all along. */
function closedDir(at: (u: number, v: number) => V3, dom: [number, number, number, number], dir: 'u' | 'v', size: number): boolean {
  const [u0, u1, v0, v1] = dom;
  for (let k = 0; k <= 4; k++) {
    const s = k / 4;
    const a = dir === 'u' ? at(u0, v0 + (v1 - v0) * s) : at(u0 + (u1 - u0) * s, v0);
    const b = dir === 'u' ? at(u1, v0 + (v1 - v0) * s) : at(u0 + (u1 - u0) * s, v1);
    if (Math.sqrt(dist2(a, b)) > 1e-6 * size + 1e-7) return false;
  }
  return true;
}

const wrapInto = (x: number, lo: number, period: number) => (period ? lo + ((((x - lo) % period) + period) % period) : x);

export function splineParam(S: Surface): Param {
  const dom = surfaceDomain(S);
  const [u0, u1, v0, v1] = dom;
  let size = 0;
  for (const row of S.P) for (const p of row) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const raw = (u: number, v: number) => surfaceAt(S, Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v)));
  const uPeriod = closedDir(raw, dom, 'u', size) ? u1 - u0 : 0;
  const vPeriod = closedDir(raw, dom, 'v', size) ? v1 - v0 : 0;
  const at = (u: number, v: number) => raw(wrapInto(u, u0, uPeriod), wrapInto(v, v0, vPeriod));
  return { at, inv: numericInverse(at, dom, uPeriod, vPeriod), uPeriod, vPeriod, vMin: v0, vMax: v1 };
}

/** Linear extrusion: S(u, v) = C(u) + v·V. `range` bounds the curve's parameter for searches (lines are infinite). */
export function extrusionParam(C: CurveFn, V: V3, range: [number, number]): Param {
  const d = norm(V), m = len(V) || 1;
  const at = (u: number, v: number) => add(C.at(u), scale(V, v));
  const [a, b] = C.period ? [C.t0, C.t1] : range;
  const across = (q: V3, p: V3) => { const w = sub(q, p); return dot(w, w) - dot(w, d) ** 2; };
  const samples = curveSamples(C, a, b, 128);
  return {
    at,
    inv: (p, hint) => {
      let u = nearestT(C, (q) => across(q, p), a, b, 128, samples);
      if (hint && C.period) u = unwrapNear(u, hint[0], C.period);
      return [u, dot(sub(p, C.at(u)), d) / m];
    },
    uPeriod: C.period, vPeriod: 0, vMin: -Infinity, vMax: Infinity,
  };
}

/** Surface of revolution: u is the angle about the axis, v the profile curve's parameter. */
export function revolutionParam(C: CurveFn, A: V3, D: V3, range: [number, number]): Param {
  const z = norm(D);
  const [a, b] = C.period ? [C.t0, C.t1] : range;
  // a reference direction across the axis: towards the profile's middle
  let x = sub(C.at((a + b) / 2), A);
  x = sub(x, scale(z, dot(x, z)));
  if (len(x) < 1e-9) x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  x = norm(sub(x, scale(z, dot(x, z))));
  const y = cross(z, x);
  const rot = (q: V3, ang: number): V3 => {
    // Rodrigues about the axis through A
    const w = sub(q, A), c = Math.cos(ang), s = Math.sin(ang);
    return add(A, add(add(scale(w, c), scale(cross(z, w), s)), scale(z, dot(z, w) * (1 - c))));
  };
  const cyl = (q: V3): V3 => { const w = sub(q, A); const h = dot(w, z); return [h, Math.hypot(dot(w, x), dot(w, y)), Math.atan2(dot(w, y), dot(w, x))]; };
  const samples = curveSamples(C, a, b, 128);
  const prof = samples.p.map(cyl);
  return {
    at: (u, v) => rot(C.at(v), u),
    inv: (p, hint) => {
      const [h, rho, th] = cyl(p);
      let k = 0, best = Infinity;
      prof.forEach((q, i) => { const e = (q[0] - h) ** 2 + (q[1] - rho) ** 2; if (e < best) { best = e; k = i; } });
      const lo = samples.t[Math.max(0, k - 1)], hi = samples.t[Math.min(samples.t.length - 1, k + 1)];
      const v = refine1((t) => { const q = cyl(C.at(t)); return (q[0] - h) ** 2 + (q[1] - rho) ** 2; }, lo, hi);
      let u = th - cyl(C.at(v))[2];
      u = hint ? unwrapNear(u, hint[0], TAU) : u;
      return [u, v];
    },
    uPeriod: TAU, vPeriod: C.period, vMin: a, vMax: b,
  };
}

/** Offset surface: the basis moved along its unit normal. */
export function offsetParam(B: Param, distance: number): Param {
  const h = 1e-6;
  const normal = (u: number, v: number): V3 => {
    let n = cross(sub(B.at(u + h, v), B.at(u - h, v)), sub(B.at(u, v + h), B.at(u, v - h)));
    if (len(n) < 1e-18) n = cross(sub(B.at(u + 1e-3, v), B.at(u, v)), sub(B.at(u, v + 1e-3), B.at(u, v)));
    return norm(n);
  };
  return {
    at: (u, v) => add(B.at(u, v), scale(normal(u, v), distance)),
    inv: (p, hint) => B.inv(p, hint),
    uPeriod: B.uPeriod, vPeriod: B.vPeriod, vMin: B.vMin, vMax: B.vMax,
  };
}

/** The same surface with u and v swapped (its natural normal flips). */
export function transposed(P: Param): Param {
  return {
    at: (u, v) => P.at(v, u),
    inv: (p, hint) => { const [u, v] = P.inv(p, hint ? [hint[1], hint[0]] : null); return [v, u]; },
    uPeriod: P.vPeriod, vPeriod: P.uPeriod, vMin: -Infinity, vMax: Infinity,
  };
}

export const _test = { nearestT, refine1 };
