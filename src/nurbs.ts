// B-spline / NURBS curves and surfaces from STEP: evaluation with the Cox–de Boor basis.
type V3 = [number, number, number];

/** Full knot vector from STEP's distinct knots and their multiplicities. */
export function expandKnots(mults: number[], knots: number[]): number[] {
  const out: number[] = [];
  mults.forEach((m, i) => { for (let k = 0; k < m; k++) out.push(knots[i]); });
  return out;
}

function findSpan(n: number, p: number, t: number, U: number[]) {
  // n = number of control points - 1
  if (t >= U[n + 1]) return n;
  if (t <= U[p]) return p;
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
  while (t < U[mid] || t >= U[mid + 1]) { if (t < U[mid]) hi = mid; else lo = mid; mid = (lo + hi) >> 1; }
  return mid;
}
function basisFuns(span: number, t: number, p: number, U: number[]): number[] {
  const N = [1], left = [0], right = [0];
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[span + 1 - j]; right[j] = U[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return N;
}

export interface Curve { p: number; P: V3[]; U: number[]; W: number[] | null }
export function curveDomain(c: Curve): [number, number] { return [c.U[c.p], c.U[c.P.length]]; }
export function curveAt(c: Curve, t: number): V3 {
  const n = c.P.length - 1, s = findSpan(n, c.p, t, c.U), N = basisFuns(s, t, c.p, c.U);
  let x = 0, y = 0, z = 0, w = 0;
  for (let j = 0; j <= c.p; j++) {
    const i = s - c.p + j, wi = c.W ? c.W[i] : 1, b = N[j] * wi;
    x += b * c.P[i][0]; y += b * c.P[i][1]; z += b * c.P[i][2]; w += b;
  }
  return [x / w, y / w, z / w];
}
/** Points along the whole curve: `per` samples in every knot span (more for long spans). */
export function sampleCurve(c: Curve, tol: number): { t: number[]; pts: V3[] } {
  const [t0, t1] = curveDomain(c);
  const ts: number[] = [];
  const distinct = [...new Set(c.U.filter((u) => u >= t0 && u <= t1))].sort((a, b) => a - b);
  for (let k = 0; k + 1 < distinct.length; k++) {
    const a = distinct[k], b = distinct[k + 1];
    // span length in space decides how finely to sample it
    const pa = curveAt(c, a), pm = curveAt(c, (a + b) / 2), pb = curveAt(c, b);
    const L = Math.hypot(pm[0] - pa[0], pm[1] - pa[1], pm[2] - pa[2]) + Math.hypot(pb[0] - pm[0], pb[1] - pm[1], pb[2] - pm[2]);
    // straight spans need no samples in between; curved ones about every 0.5 mm (finer for tight tolerances)
    const n = c.p === 1 ? 1 : Math.max(8, Math.min(128, Math.ceil(L / Math.max(0.05, Math.sqrt(tol) * 5))));
    for (let q = 0; q < n; q++) ts.push(a + ((b - a) * q) / n);
  }
  ts.push(t1);
  return { t: ts, pts: ts.map((t) => curveAt(c, t)) };
}

export interface Surface { pu: number; pv: number; P: V3[][]; U: number[]; V: number[]; W: number[][] | null }
export function surfaceDomain(s: Surface): [number, number, number, number] { return [s.U[s.pu], s.U[s.P.length], s.V[s.pv], s.V[s.P[0].length]]; }
export function surfaceAt(s: Surface, u: number, v: number): V3 {
  const nu = s.P.length - 1, nv = s.P[0].length - 1;
  const su = findSpan(nu, s.pu, u, s.U), sv = findSpan(nv, s.pv, v, s.V);
  const Nu = basisFuns(su, u, s.pu, s.U), Nv = basisFuns(sv, v, s.pv, s.V);
  let x = 0, y = 0, z = 0, w = 0;
  for (let a = 0; a <= s.pu; a++) for (let b = 0; b <= s.pv; b++) {
    const i = su - s.pu + a, j = sv - s.pv + b, wi = s.W ? s.W[i][j] : 1, f = Nu[a] * Nv[b] * wi;
    x += f * s.P[i][j][0]; y += f * s.P[i][j][1]; z += f * s.P[i][j][2]; w += f;
  }
  return [x / w, y / w, z / w];
}
/** Unit normal (dS/du × dS/dv) by central differences. */
export function surfaceNormal(s: Surface, u: number, v: number): V3 {
  const [u0, u1, v0, v1] = surfaceDomain(s);
  const hu = (u1 - u0) * 1e-4, hv = (v1 - v0) * 1e-4;
  const ua = Math.max(u0, u - hu), ub = Math.min(u1, u + hu), va = Math.max(v0, v - hv), vb = Math.min(v1, v + hv);
  const a = surfaceAt(s, ua, v), b = surfaceAt(s, ub, v), c = surfaceAt(s, u, va), d = surfaceAt(s, u, vb);
  const du: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dv: V3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
  const n: V3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
