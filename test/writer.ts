// A small STEP writer for test solids: planes, cylinders and cones bounded by
// lines, circles and single points, all moved by one rigid placement (so a
// board can be written at any angle).
import type { V3 } from '../src/index';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rotation about a unit axis by an angle, then a shift: the placement every point goes through. */
export function placement(axis: V3, angle: number, shift: V3 = [0, 0, 0]) {
  const [x, y, z] = norm(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  const dir = (d: V3): V3 => [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
  return { dir, point: (p: V3): V3 => { const q = dir(p); return [q[0] + shift[0], q[1] + shift[1], q[2] + shift[2]]; } };
}

type Edge = { id: number };
type Use = { edge: Edge; forward: boolean } | { vertex: number };

export class SolidWriter {
  private lines: string[] = [];
  private n = 0;
  private faces: number[] = [];
  constructor(private X = placement([0, 0, 1], 0)) {}
  private add(text: string) { this.lines.push(`#${++this.n}=${text};`); return this.n; }
  private pt(p: V3) { const q = this.X.point(p); return this.add(`CARTESIAN_POINT('',(${q.map((v) => v.toFixed(9)).join(',')}))`); }
  private dir(d: V3) { const q = norm(this.X.dir(d)); return this.add(`DIRECTION('',(${q.map((v) => v.toFixed(12)).join(',')}))`); }
  private axis(o: V3, z: V3, x: V3) { const p = this.pt(o), zd = this.dir(z), xd = this.dir(x); return this.add(`AXIS2_PLACEMENT_3D('',#${p},#${zd},#${xd})`); }

  vertex(p: V3) { return this.add(`VERTEX_POINT('',#${this.pt(p)})`); }
  line(a: number, pa: V3, b: number, pb: V3): Edge {
    const d = sub(pb, pa);
    const vec = this.add(`VECTOR('',#${this.dir(d)},${Math.hypot(...d).toFixed(9)})`);
    const ln = this.add(`LINE('',#${this.pt(pa)},#${vec})`);
    return { id: this.add(`EDGE_CURVE('',#${a},#${b},#${ln},.T.)`) };
  }
  /** a full circle about centre c in the plane normal to n, starting and ending at vertex v (at c + r·x) */
  circle(v: number, c: V3, n: V3, x: V3, r: number): Edge {
    const circ = this.add(`CIRCLE('',#${this.axis(c, n, x)},${r.toFixed(9)})`);
    return { id: this.add(`EDGE_CURVE('',#${v},#${v},#${circ},.T.)`) };
  }
  private loop(uses: Use[]) {
    if (uses.length === 1 && 'vertex' in uses[0]) return this.add(`VERTEX_LOOP('',#${uses[0].vertex})`);
    const oe = uses.map((u) => {
      if ('vertex' in u) throw new Error('a vertex in an edge loop');
      return this.add(`ORIENTED_EDGE('',*,*,#${u.edge.id},${u.forward ? '.T.' : '.F.'})`);
    });
    return this.add(`EDGE_LOOP('',(${oe.map((x) => '#' + x).join(',')}))`);
  }
  private face(surface: number, sense: boolean, loops: Use[][]) {
    const bounds = loops.map((l, k) => this.add(`${k === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${this.loop(l)},.T.)`));
    this.faces.push(this.add(`ADVANCED_FACE('',(${bounds.map((b) => '#' + b).join(',')}),#${surface},${sense ? '.T.' : '.F.'})`));
  }
  plane(o: V3, n: V3, x: V3, loops: Use[][]) { this.face(this.add(`PLANE('',#${this.axis(o, n, x)})`), true, loops); }
  cylinder(o: V3, axis: V3, x: V3, r: number, sense: boolean, loops: Use[][]) {
    this.face(this.add(`CYLINDRICAL_SURFACE('',#${this.axis(o, axis, x)},${r.toFixed(9)})`), sense, loops);
  }
  cone(o: V3, axis: V3, x: V3, r: number, semi: number, sense: boolean, loops: Use[][]) {
    this.face(this.add(`CONICAL_SURFACE('',#${this.axis(o, axis, x)},${r.toFixed(9)},${semi.toFixed(12)})`), sense, loops);
  }
  text(name: string): string {
    const shell = this.add(`CLOSED_SHELL('',(${this.faces.map((x) => '#' + x).join(',')}))`);
    this.add(`MANIFOLD_SOLID_BREP('${name}',#${shell})`);
    return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('${name}','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${this.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  }
}

/**
 * A W × D × T board (X, Y, Z) with a round hole straight through it and a blind
 * hole drilled into its +X edge with a 118° point, moved by the placement.
 */
export function drilledBoard(X = placement([0, 0, 1], 0), W = 600, D = 400, T = 18) {
  const w = new SolidWriter(X);
  // corners
  const c = (i: number, j: number, k: number): V3 => [i * W, j * D, k * T];
  const P: V3[] = [], V: number[] = [];
  for (let n = 0; n < 8; n++) { const p = c(n & 1, (n >> 1) & 1, (n >> 2) & 1); P.push(p); V.push(w.vertex(p)); }
  const E = new Map<string, Edge>();
  const e = (a: number, b: number) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const k = `${lo}-${hi}`;
    if (!E.has(k)) E.set(k, w.line(V[lo], P[lo], V[hi], P[hi]));
    return { edge: E.get(k)!, forward: a < b };
  };
  const ring = (ids: number[]) => ids.map((id, k) => e(id, ids[(k + 1) % ids.length]));

  // the through hole: radius 4 at (100, 100)
  const h: V3 = [100, 100, 0], r = 4;
  const hb = w.vertex([h[0] + r, h[1], 0]), ht = w.vertex([h[0] + r, h[1], T]);
  const cb = w.circle(hb, h, [0, 0, 1], [1, 0, 0], r), ct = w.circle(ht, [h[0], h[1], T], [0, 0, 1], [1, 0, 0], r);
  // the edge hole: radius 2.5 into the +X face at (y 200, z 9), 30 deep, then the drill point
  const er = 2.5, depth = 30, semi = (59 * Math.PI) / 180;
  const eo: V3 = [W, 200, 9], ei: V3 = [W - depth, 200, 9], tip: V3 = [W - depth - er / Math.tan(semi), 200, 9];
  const eo1 = w.vertex([W, 200, 9 + er]), ei1 = w.vertex([W - depth, 200, 9 + er]), tipV = w.vertex(tip);
  const ceo = w.circle(eo1, eo, [-1, 0, 0], [0, 0, 1], er), cei = w.circle(ei1, ei, [-1, 0, 0], [0, 0, 1], er);

  // outer faces, counter-clockwise seen from outside; holes the other way
  w.plane([0, 0, 0], [0, 0, -1], [1, 0, 0], [ring([0, 2, 3, 1]), [{ edge: cb, forward: true }]]);          // bottom
  w.plane([0, 0, T], [0, 0, 1], [1, 0, 0], [ring([4, 5, 7, 6]), [{ edge: ct, forward: false }]]);           // top
  w.plane([0, 0, 0], [0, -1, 0], [1, 0, 0], [ring([0, 1, 5, 4])]);                                          // front
  w.plane([0, D, 0], [0, 1, 0], [1, 0, 0], [ring([2, 6, 7, 3])]);                                           // back
  w.plane([0, 0, 0], [-1, 0, 0], [0, 1, 0], [ring([0, 4, 6, 2])]);                                          // left
  w.plane([W, 0, 0], [1, 0, 0], [0, 1, 0], [ring([1, 3, 7, 5]), [{ edge: ceo, forward: true }]]);           // right, with the edge hole
  // the through hole's wall: material outside, so the face looks in towards the axis
  w.cylinder(h, [0, 0, 1], [1, 0, 0], r, false, [[{ edge: cb, forward: false }], [{ edge: ct, forward: true }]]);
  // the edge hole's wall and its drill point
  w.cylinder(ei, [1, 0, 0], [0, 0, 1], er, false, [[{ edge: ceo, forward: false }], [{ edge: cei, forward: true }]]);
  // cone: radius er at the bottom of the hole, axis back out of the hole, so it narrows towards the tip
  w.cone(ei, [1, 0, 0], [0, 0, 1], er, semi, false, [[{ edge: cei, forward: false }], [{ vertex: tipV }]]);
  const volume = W * D * T - Math.PI * r * r * T - Math.PI * er * er * depth - (Math.PI * er * er * (er / Math.tan(semi))) / 3;
  return { text: w.text('Drilled board'), volume };
}

/** A round dowel of radius r and length L along X, moved by the placement. */
export function dowel(X = placement([0, 0, 1], 0), r = 4, L = 40) {
  const w = new SolidWriter(X);
  const a = w.vertex([0, 0, r]), b = w.vertex([L, 0, r]);
  const ca = w.circle(a, [0, 0, 0], [1, 0, 0], [0, 0, 1], r), cb = w.circle(b, [L, 0, 0], [1, 0, 0], [0, 0, 1], r);
  w.plane([0, 0, 0], [-1, 0, 0], [0, 0, 1], [[{ edge: ca, forward: false }]]);
  w.plane([L, 0, 0], [1, 0, 0], [0, 0, 1], [[{ edge: cb, forward: true }]]);
  w.cylinder([0, 0, 0], [1, 0, 0], [0, 0, 1], r, true, [[{ edge: ca, forward: true }], [{ edge: cb, forward: false }]]);
  return { text: w.text('Dowel'), volume: Math.PI * r * r * L };
}
