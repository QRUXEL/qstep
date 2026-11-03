// Thin wrapper around Clipper (clipper-lib, the JS port of Angus Johnson's
// Clipper 6) working in millimetre floats; integers at SCALE units per mm inside.
// (clipper2-js was dropped: its offset, point-in-polygon and open-path clipping
// all returned wrong results on simple inputs.)
import ClipperLib from 'clipper-lib';

export const SCALE = 1000;               // 1 µm resolution
export type Pt = [number, number];
export type Ring = Pt[];
/** A polygon with holes: [outer, ...holes]. Outer is counter-clockwise, holes clockwise. */
export type Poly = Ring[];
type IP = { X: number; Y: number };

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return -a / 2;                          // positive = counter-clockwise
}
export function polyArea(p: Poly): number {
  return p.reduce((s, r) => s + ringArea(r), 0);
}
const toPath = (r: Ring): IP[] => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = (p: IP[]): Ring => p.map((q) => [q.X / SCALE, q.Y / SCALE] as Pt);
const toPaths = (rings: Ring[]): IP[][] => rings.filter((r) => r.length >= 3).map(toPath);

/** Orient a polygon: outer CCW, holes CW (so NonZero unions of many polygons are correct). */
export function orient(p: Poly): Poly {
  return p.map((r, k) => {
    const a = ringArea(r);
    return (k === 0 ? a < 0 : a > 0) ? [...r].reverse() : r;
  });
}

/** Strictly inside (even-odd crossing test); points on the boundary may go either way. */
export function insideRing([x, y]: Pt, r: Ring): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** PolyTree -> polygons with holes (islands inside holes become polygons of their own). */
function fromTree(tree: any, minArea: number): Poly[] {
  const out: Poly[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      const outer = fromPath(n.Contour());
      const holes = n.Childs().map((h: any) => fromPath(h.Contour())).filter((h: Ring) => h.length >= 3 && Math.abs(ringArea(h)) >= minArea * 0.5);
      if (outer.length >= 3 && Math.abs(ringArea(outer)) + holes.reduce((s: number, h: Ring) => s - Math.abs(ringArea(h)), 0) >= minArea) out.push(orient([outer, ...holes]));
      for (const h of n.Childs()) walk(h.Childs());
    }
  };
  walk(tree.Childs());
  return out;
}
function run(ct: number, a: IP[][], b: IP[][] | null, minArea: number): Poly[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  if (b) c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ct, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromTree(tree, minArea);
}

/** Union of polygons (each [outer, ...holes]); returns separate polygons with holes. */
export function union(polys: Poly[], minArea = 0): Poly[] {
  return run(ClipperLib.ClipType.ctUnion, toPaths(polys.flatMap(orient)), null, minArea);
}
export function difference(a: Poly[], b: Poly[], minArea = 0): Poly[] {
  return run(ClipperLib.ClipType.ctDifference, toPaths(a.flatMap(orient)), toPaths(b.flatMap(orient)), minArea);
}
export function intersect(a: Poly[], b: Poly[], minArea = 0): Poly[] {
  return run(ClipperLib.ClipType.ctIntersection, toPaths(a.flatMap(orient)), toPaths(b.flatMap(orient)), minArea);
}

/** Offset polygons by delta mm (negative shrinks). Round joins by default (arcs within 2 µm). */
export function offset(polys: Poly[], delta: number, join: 'round' | 'miter' | 'square' = 'round', minArea = 0): Poly[] {
  const jt = join === 'round' ? ClipperLib.JoinType.jtRound : join === 'miter' ? ClipperLib.JoinType.jtMiter : ClipperLib.JoinType.jtSquare;
  const co = new ClipperLib.ClipperOffset(4, 0.002 * SCALE);
  co.AddPaths(toPaths(polys.flatMap(orient)), jt, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, delta * SCALE);
  return fromTree(tree, minArea);
}

/** Area within `r` mm of open polylines (round ends), as polygons with holes. */
export function offsetLines(lines: Pt[][], r: number, arcTol = 0.02): Poly[] {
  const co = new ClipperLib.ClipperOffset(4, arcTol * SCALE);
  co.AddPaths(lines.filter((l) => l.length >= 2).map(toPath), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, r * SCALE);
  return fromTree(tree, 0);
}

/** Douglas-Peucker simplification of every ring (tolerance in mm). */
export function simplify(polys: Poly[], tol: number): Poly[] {
  return polys.map((p) => p.map((r) => { const s = dpRing(r, tol); return s.length >= 3 ? s : r; }));
}
/** Douglas-Peucker on an open polyline (tolerance in mm). */
export function simplifyLine(pts: Pt[], tol: number): Pt[] { return dp(pts, tol); }
function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = pts[i], [bx, by] = pts[j], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = L > 1e-9 ? Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L : Math.hypot(pts[k][0] - ax, pts[k][1] - ay);
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
function dpRing(r: Ring, tol: number): Ring {
  if (r.length < 4) return r;
  // split at the point farthest from the first so both halves are open chains
  let far = 0, fd = -1;
  r.forEach((p, k) => { const d = Math.hypot(p[0] - r[0][0], p[1] - r[0][1]); if (d > fd) { fd = d; far = k; } });
  const a = dp(r.slice(0, far + 1), tol), b = dp([...r.slice(far), r[0]], tol);
  return [...a, ...b.slice(1, -1)];
}

export function round3(p: Poly): Poly {
  return p.map((r) => r.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as Pt));
}

/** Clip open polylines to a region (even-odd over all rings). Returns the pieces
 * inside and whether anything was cut. (clipper2-js drops open paths that lie
 * wholly inside, so this is done here: split at crossings, keep inside pieces.) */
export function clipLines(lines: Pt[][], region: Poly[]): { lines: Pt[][]; cut: boolean } {
  const rings = region.flat().filter((r) => r.length >= 3);
  // edges with bounding boxes, bucketed into horizontal bands for speed
  type E = [number, number, number, number];
  const edges: E[] = [];
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) edges.push([r[j][0], r[j][1], r[i][0], r[i][1]]);
  let y0 = Infinity, y1 = -Infinity;
  for (const e of edges) { y0 = Math.min(y0, e[1], e[3]); y1 = Math.max(y1, e[1], e[3]); }
  const NB = Math.max(1, Math.min(256, edges.length >> 2)), bh = (y1 - y0) / NB || 1;
  const band: E[][] = Array.from({ length: NB }, () => []);
  const bi = (y: number) => Math.max(0, Math.min(NB - 1, Math.floor((y - y0) / bh)));
  for (const e of edges) for (let b = bi(Math.min(e[1], e[3])); b <= bi(Math.max(e[1], e[3])); b++) band[b].push(e);
  const inside = (x: number, y: number) => {
    if (y < y0 || y > y1) return false;
    let c = false;
    for (const [xa, ya, xb, yb] of band[bi(y)]) if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c;
    return c;
  };
  const out: Pt[][] = [];
  let cut = false;
  for (const l of lines) {
    let cur: Pt[] | null = null;
    for (let k = 0; k + 1 < l.length; k++) {
      const [ax, ay] = l[k], [bx, by] = l[k + 1], dx = bx - ax, dy = by - ay;
      const ts: number[] = [0];
      const lo = bi(Math.min(ay, by)), hi = bi(Math.max(ay, by));
      const seen = new Set<E>();
      for (let b = lo; b <= hi; b++) for (const e of band[b]) {
        if (seen.has(e)) continue; seen.add(e);
        const ex = e[2] - e[0], ey = e[3] - e[1], den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((e[0] - ax) * ey - (e[1] - ay) * ex) / den, u = ((e[0] - ax) * dy - (e[1] - ay) * dx) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.push(1); ts.sort((a, b) => a - b);
      for (let m = 0; m + 1 < ts.length; m++) {
        const ta = ts[m], tb = ts[m + 1];
        if (tb - ta < 1e-9) continue;
        const tm = (ta + tb) / 2;
        const pa: Pt = [ax + dx * ta, ay + dy * ta], pb: Pt = [ax + dx * tb, ay + dy * tb];
        if (inside(ax + dx * tm, ay + dy * tm)) {
          if (!cur) { cur = [pa]; if (ta > 0 || k > 0) cut = cut || ta > 0; }
          cur.push(pb);
        } else {
          cut = true;
          if (cur) { if (cur.length >= 2) out.push(cur); cur = null; }
        }
      }
    }
    if (cur && cur.length >= 2) out.push(cur);
  }
  return { lines: out, cut };
}
