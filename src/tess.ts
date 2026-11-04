// Triangulates a curved face in its surface's (u, v) space.
//
// The boundary loops are mapped to (u, v) and unwrapped across the seams of
// closed directions. The region is then cut into vertical strips at every
// boundary vertex (and at regular steps where the surface bends); in each
// strip the boundary crossings, sorted by v, bound the inside intervals. Each
// interval is filled between its left and right edges with rows at fixed v
// steps shared by all strips, and every point is mapped back onto the true
// surface. Works for any surface with an inverse, in any orientation: holes,
// bands and partial walls of cylinders and cones, sphere caps running to a
// pole, tori, trimmed B-splines, extrusions and revolutions.
import type { Param, UV, V3 } from "./surface";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

export interface TessOptions {
  /** largest turn of the surface normal across one triangle, radians */
  maxAngle: number;
  /** cap on strips and rows per face */
  maxSteps?: number;
  /**
   * boundary points closer than this to the line through their neighbours are dropped, mm.
   * Keep it small: a kept stretch is a straight line in (u, v), not in 3D, so where the face
   * bends along it (a flat cut through a cone) the mesh leaves the true edge by more than this.
   */
  tol?: number;
}

/** Douglas–Peucker on a closed 3D loop: keeps the corners, drops points along gentle stretches. */
function simplifyLoop(l: V3[], tol: number): V3[] {
  if (l.length < 8) return l;
  const d2seg = (p: V3, a: V3, b: V3) => {
    const ab = sub(b, a), ap = sub(p, a), L = dot(ab, ab);
    const t = L > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / L)) : 0;
    const q: V3 = [a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]];
    return dot(q, q);
  };
  // split the loop at its first point and the point farthest from it
  let far = 0, fd = -1;
  l.forEach((p, k) => { const d = dot(sub(p, l[0]), sub(p, l[0])); if (d > fd) { fd = d; far = k; } });
  const keep = new Uint8Array(l.length);
  keep[0] = keep[far] = 1;
  const t2 = tol * tol;
  const stack: [number, number][] = [[0, far], [far, l.length]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pb = l[b % l.length];
    let best = -1, bd = t2;
    for (let k = a + 1; k < b; k++) { const d = d2seg(l[k], l[a], pb); if (d > bd) { bd = d; best = k; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return l.filter((_, k) => keep[k]);
}

export interface FaceMesh { pos: number[]; nor: number[]; idx: number[] }

const unwrapNear = (x: number, ref: number, period: number) => (period ? x + Math.round((ref - x) / period) * period : x);

/**
 * Meshes a face given as 3D boundary loops on surface `S`. `sign` is the
 * face's same_sense (+1/−1): triangles face along the natural normal times it.
 * Returns null when the region can't be read in (u, v).
 */
export function tessellate(S: Param, loops3: V3[][], sign: number, o: TessOptions): FaceMesh | null {
  const maxSteps = o.maxSteps ?? 1024;
  const h = 1e-6;
  const du = (u: number, v: number) => len(sub(S.at(u + h, v), S.at(u - h, v)));
  const dv = (u: number, v: number) => len(sub(S.at(u, v + h), S.at(u, v - h)));

  // ---- boundary in (u, v)
  const loops: UV[][] = [];
  for (let l3 of loops3) {
    if (l3.length < 2) continue;
    l3 = simplifyLoop(l3, o.tol ?? 0.001);
    let hint: UV | null = null;
    const raw: UV[] = l3.map((p) => { const q = S.inv(p, hint); hint = q; return q; });
    // poles (and cone apexes): u means nothing where the surface collapses to a point;
    // such a point takes the u of each neighbour in turn, which runs the boundary along the pole line
    const out: UV[] = [];
    const n = raw.length;
    for (let k = 0; k < n; k++) {
      const q = raw[k];
      const degenerate = du(q[0], q[1]) < 1e-3 * Math.max(dv(q[0], q[1]), 1e-9) || du(q[0], q[1]) < 1e-12;
      if (!degenerate) { out.push(q); continue; }
      const prev = raw[(k - 1 + n) % n], next = raw[(k + 1) % n];
      out.push([prev[0], q[1]]);
      if (Math.abs(next[0] - prev[0]) > 1e-9) out.push([unwrapNear(next[0], prev[0], S.uPeriod), q[1]]);
    }
    // continuous across seams
    for (let k = 1; k < out.length; k++) {
      out[k] = [unwrapNear(out[k][0], out[k - 1][0], S.uPeriod), unwrapNear(out[k][1], out[k - 1][1], S.vPeriod)];
    }
    loops.push(out);
  }
  if (!loops.length) return null;

  // a loop closes back onto its start, give or take whole periods (a band's circle goes once round)
  const closing = (l: UV[]): UV => {
    const last = l[l.length - 1];
    return [unwrapNear(l[0][0], last[0], S.uPeriod), unwrapNear(l[0][1], last[1], S.vPeriod)];
  };
  const wrapsU = loops.some((l) => S.uPeriod && Math.abs(closing(l)[0] - l[0][0]) > S.uPeriod / 2);
  const wrapsV = loops.some((l) => S.vPeriod && Math.abs(closing(l)[1] - l[0][1]) > S.vPeriod / 2);
  if (wrapsV && !wrapsU) {
    // loops that go round the v direction (round a torus's tube): strips run the other way
    const T: Param = {
      at: (u, v) => S.at(v, u), inv: (p, hint) => { const [u, v] = S.inv(p, hint ? [hint[1], hint[0]] : null); return [v, u]; },
      uPeriod: S.vPeriod, vPeriod: S.uPeriod, vMin: -Infinity, vMax: Infinity,
    };
    return fill(T, loops.map((l) => l.map(([u, v]) => [v, u] as UV)), -sign);
  }
  if (wrapsU && wrapsV) return null;
  return fill(S, loops, sign);

  function fill(S: Param, loops: UV[][], sign: number): FaceMesh | null {
    const P = S.uPeriod;
    // loops sit in one period window: shift each so it overlaps the first loop's range
    if (S.vPeriod) {
      const ref = loops[0][0][1];
      for (const l of loops) { const d = unwrapNear(l[0][1], ref, S.vPeriod) - l[0][1]; for (const q of l) q[1] += d; }
    }

    // every surface's natural normal here is dS/du × dS/dv (the STEP convention), so the
    // face's sense says which way (u, v) turns about the face normal; the bounds agree with it
    // (counter-clockwise round the normal), which decides where an odd set of crossings is open
    const inAbove = sign > 0;

    // ---- edges, repeated a period either side so a strip sees every crossing
    type Edge = { u0: number; v0: number; u1: number; v1: number };
    const edges: Edge[] = [];
    let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
    for (const l of loops) for (const q of l) { uLo = Math.min(uLo, q[0]); uHi = Math.max(uHi, q[0]); vLo = Math.min(vLo, q[1]); vHi = Math.max(vHi, q[1]); }
    // as many periods either side as the loops span (a thread's boundary goes round several times)
    const reach = P ? Math.ceil((uHi - uLo) / P) + 1 : 0;
    for (const l of loops) {
      const pts = [...l, closing(l)];
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        if (Math.abs(b[0] - a[0]) < 1e-12) continue;
        for (let s = -reach; s <= reach; s++) edges.push({ u0: a[0] + s * P, v0: a[1], u1: b[0] + s * P, v1: b[1] });
      }
    }
    if (!edges.length) return null;
    // v of an edge at u, held within the edge's own ends: a strip can be wider than a steep
    // segment, and running the segment on past its ends would throw the boundary far off
    const vOn = (e: Edge, u: number) => {
      const t = Math.min(1, Math.max(0, (u - e.u0) / (e.u1 - e.u0)));
      return e.v0 + t * (e.v1 - e.v0);
    };
    const crossings = (list: Edge[], um: number) => list
      .filter((e) => (e.u0 - um) * (e.u1 - um) < 0)
      .map((e) => ({ e, v: vOn(e, um), starts: e.u1 > e.u0 === inAbove })) // starts: the inside lies above
      .sort((a, b) => a.v - b.v);
    // Is the region open at the bottom of the range (a ball with holes in it, the far side of a pole)?
    // Bounds keep the inside on their left, so the lowest crossing of a strip tells: an edge that
    // ends the inside has the inside below it. Voted over a few strips.
    let bottomInside = false;
    if (Number.isFinite(S.vMin) && Number.isFinite(S.vMax)) {
      let yes = 0, no = 0;
      const span = P || uHi - uLo;
      for (let k = 0; k < 17; k++) {
        const hits = crossings(edges, uLo + (span * (k + 0.5)) / 17);
        if (hits.length) { if (hits[0].starts) no++; else yes++; }
      }
      bottomInside = yes > no;
    }
    const winLo = uLo, winHi = P && (wrapsU || bottomInside || uHi - uLo > P) ? uLo + P : uHi;

    // ---- how finely to step: the normal's turn per unit of u and of v, sampled over the region
    const normalAt = (u: number, v: number): V3 | null => {
      const n = cross(sub(S.at(u + h, v), S.at(u - h, v)), sub(S.at(u, v + h), S.at(u, v - h)));
      const l = len(n);
      return l > 1e-20 ? [n[0] / l, n[1] / l, n[2] / l] : null;
    };
    let rateU = 0, rateV = 0;
    // a region that runs to a pole reaches past its boundary to the end of the range
    const extLo = Number.isFinite(S.vMin) ? Math.min(vLo, S.vMin) : vLo, extHi = Number.isFinite(S.vMax) ? Math.max(vHi, S.vMax) : vHi;
    // small steps: a long step can land a whole turn further along a thread and see no bend at all
    const eu = Math.max((winHi - winLo) / 400, 1e-5), ev = Math.max((extHi - extLo) / 400, 1e-5);
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const u = winLo + ((winHi - winLo) * (i + 0.37)) / 13, v = extLo + ((extHi - extLo) * (j + 0.41)) / 13;
      const n0 = normalAt(u, v), nu = normalAt(u + eu, v), nv = normalAt(u, v + ev);
      if (!n0) continue;
      if (nu) rateU = Math.max(rateU, Math.acos(Math.min(1, Math.max(-1, dot(n0, nu)))) / eu);
      if (nv) rateV = Math.max(rateV, Math.acos(Math.min(1, Math.max(-1, dot(n0, nv)))) / ev);
    }
    const stepU = rateU > 1e-9 ? Math.max(o.maxAngle / rateU, (winHi - winLo) / maxSteps, 1e-6) : Infinity;
    const stepV = rateV > 1e-9 ? Math.max(o.maxAngle / rateV, (extHi - extLo) / maxSteps, 1e-6) : Infinity;

    // ---- strip boundaries: every vertex u (into the window) plus regular steps
    const cuts = new Set<number>();
    const key = (u: number) => Math.round(u * 1e9) / 1e9;
    cuts.add(key(winLo)); cuts.add(key(winHi));
    for (const l of loops) for (const q of l) {
      let u = q[0];
      if (P) u = winLo + ((((u - winLo) % P) + P) % P);
      if (u >= winLo && u <= winHi) cuts.add(key(u));
    }
    if (Number.isFinite(stepU)) {
      const n = Math.ceil((winHi - winLo) / stepU);
      for (let k = 1; k < n; k++) cuts.add(key(winLo + ((winHi - winLo) * k) / n));
    }
    let us = [...cuts].sort((a, b) => a - b);
    // every strip runs through every row: keep strips × rows within a budget (a thread's flank
    // has hundreds of rows and a dense boundary), merging strips narrower than the window over the cap
    const rowCount = Number.isFinite(stepV) ? Math.max(1, (extHi - extLo) / stepV) : 1;
    // a thread's boundary crosses every strip once per turn: count the intervals in a few strips
    let intervals = 1;
    for (let k = 0; k < 9; k++) intervals = Math.max(intervals, crossings(edges, winLo + ((winHi - winLo) * (k + 0.5)) / 9).length / 2);
    const minStrips = Number.isFinite(stepU) ? Math.ceil((winHi - winLo) / stepU) : 1;
    const maxStrips = Math.max(32, minStrips, Math.min(maxSteps * 2, Math.floor(15000 / (rowCount * intervals))));
    if (us.length > maxStrips) {
      const gap = (winHi - winLo) / maxStrips;
      const kept = [us[0]];
      for (const u of us.slice(1, -1)) if (u - kept[kept.length - 1] >= gap) kept.push(u);
      kept.push(us[us.length - 1]);
      us = kept;
    }

    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    const vRow0 = vLo;
    const rows = (a: number, b: number): number[] => {
      // the shared v rows strictly between a and b
      if (!Number.isFinite(stepV) || b - a <= 1e-12) return [];
      const out: number[] = [];
      for (let k = Math.floor((a - vRow0) / stepV) + 1; vRow0 + k * stepV < b - 1e-9; k++) {
        const v = vRow0 + k * stepV;
        if (v > a + 1e-9) out.push(v);
      }
      return out;
    };
    const vert = (u: number, v: number, uc: number, vc: number) => {
      const p = S.at(u, v);
      // at a pole the normal is taken a little way into the strip
      let n = normalAt(u, v) ?? normalAt(u + (uc - u) * 0.01, v + (vc - v) * 0.01) ?? [0, 0, 1];
      if (!inAbove) n = [-n[0], -n[1], -n[2]];
      pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]);
      return pos.length / 3 - 1;
    };
    // (u, v) is right-handed about the face normal when inAbove; flip triangles otherwise
    const tri = (a: number, b: number, c: number) => { if (inAbove) idx.push(a, b, c); else idx.push(a, c, b); };

    // edges sorted by where they start in u, swept left to right
    const byLo = edges.map((e) => ({ e, lo: Math.min(e.u0, e.u1), hi: Math.max(e.u0, e.u1) })).sort((a, b) => a.lo - b.lo);
    let next = 0, active: typeof byLo = [];
    for (let k = 0; k + 1 < us.length; k++) {
      const ua = us[k], ub = us[k + 1];
      if (ub - ua < 1e-10) continue;
      const um = (ua + ub) / 2;
      while (next < byLo.length && byLo[next].lo < um) active.push(byLo[next++]);
      active = active.filter((a) => a.hi > um);
      const hits = crossings(active.map((a) => a.e), um);
      // inside intervals, bottom to top, as [v at ua, v at ub] for each end
      type End = [number, number];
      const at = (j: number, shift = 0): End => [vOn(hits[j].e, ua) + shift, vOn(hits[j].e, ub) + shift];
      const bottom: End = [S.vMin, S.vMin], top: End = [S.vMax, S.vMax];
      const spans: [End, End][] = [];
      const lowEnd = Number.isFinite(S.vMin), highEnd = Number.isFinite(S.vMax);
      if (hits.length % 2 === 1 && lowEnd !== highEnd) {
        // only one end can close a region (a cone's apex): an odd set of crossings runs to it
        if (lowEnd) { spans.push([bottom, at(0)]); for (let j = 1; j + 1 < hits.length; j += 2) spans.push([at(j), at(j + 1)]); }
        else { for (let j = 0; j + 1 < hits.length; j += 2) spans.push([at(j), at(j + 1)]); spans.push([at(hits.length - 1), top]); }
      } else if (S.vPeriod && hits.length && !hits[0].starts) {
        // closed in v (round a torus's tube) with the inside below the lowest crossing: the
        // interval that is still open at the top runs on round to it, one period up
        let open = -1;
        hits.forEach((hit, j) => {
          if (hit.starts && open < 0) open = j;
          else if (!hit.starts && open >= 0) { spans.push([at(open), at(j)]); open = -1; }
        });
        if (open >= 0) spans.push([at(open), at(0, S.vPeriod)]);
      } else {
        // an edge with the inside above opens an interval, the next with the inside below closes it;
        // open ends run to the end of the range (a pole)
        let inside = bottomInside, open: End = bottom;
        hits.forEach((hit, j) => {
          if (hit.starts && !inside) { open = at(j); inside = true; }
          else if (!hit.starts && inside) { spans.push([open, at(j)]); inside = false; }
        });
        if (inside) spans.push([open, top]);
      }
      for (const [[loA, loB], [hiA, hiB]] of spans) {
        if (![loA, loB, hiA, hiB].every(Number.isFinite)) continue;
        const vc = (loA + loB + hiA + hiB) / 4;
        // left and right chains, bottom to top, filled as a ladder
        const L = [loA, ...rows(loA, hiA), hiA], R = [loB, ...rows(loB, hiB), hiB];
        if (hiA - loA < 1e-12) L.length = 1;
        if (hiB - loB < 1e-12) R.length = 1;
        const li = L.map((v) => vert(ua, v, um, vc)), ri = R.map((v) => vert(ub, v, um, vc));
        let i = 0, j = 0;
        while (i + 1 < L.length || j + 1 < R.length) {
          // advance on the side whose next point is lower
          if (j + 1 >= R.length || (i + 1 < L.length && L[i + 1] <= R[j + 1])) { tri(li[i], ri[j], li[i + 1]); i++; }
          else { tri(li[i], ri[j], ri[j + 1]); j++; }
        }
      }
    }
    return { pos, nor, idx };
  }
}
