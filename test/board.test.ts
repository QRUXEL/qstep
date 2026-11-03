import { describe, expect, test } from 'bun:test';
import { parseStep, readBoards, applyXf, ringArea, type V3 } from '../src/index';

/** STEP text for a box solid: corner o, edge vectors a, b, c (mm). */
function boxStep(name: string, o: V3, a: V3, b: V3, c: V3): string {
  let id = 0;
  const lines: string[] = [];
  const add = (text: string) => { lines.push(`#${++id}=${text};`); return id; };
  const pt = (p: V3) => add(`CARTESIAN_POINT('',(${p.map((v) => v.toFixed(6)).join(',')}))`);
  const dir = (d: V3) => { const l = Math.hypot(...d); return add(`DIRECTION('',(${d.map((v) => (v / l).toFixed(9)).join(',')}))`); };
  const corner = (i: number, j: number, k: number): V3 => [0, 1, 2].map((n) => o[n] + i * a[n] + j * b[n] + k * c[n]) as V3;
  const P: V3[] = [];
  const V: number[] = [];
  for (let n = 0; n < 8; n++) { const p = corner(n & 1, (n >> 1) & 1, (n >> 2) & 1); P.push(p); V.push(add(`VERTEX_POINT('',#${pt(p)})`)); }
  const edges = new Map<string, number>();
  const edge = (u: number, v: number) => {
    const [lo, hi] = u < v ? [u, v] : [v, u];
    const key = `${lo}-${hi}`;
    if (!edges.has(key)) {
      const d = [0, 1, 2].map((n) => P[hi][n] - P[lo][n]) as V3;
      const line = add(`LINE('',#${pt(P[lo])},VECTOR('',#${dir(d)},${Math.hypot(...d).toFixed(6)}))`);
      edges.set(key, add(`EDGE_CURVE('',#${V[lo]},#${V[hi]},#${line},.T.)`));
    }
    return { id: edges.get(key)!, forward: u < v };
  };
  const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const faces: number[] = [];
  // each side: the axis bit fixed at 0 or 1, the other two bits walked round
  for (const axis of [0, 1, 2]) {
    for (const side of [0, 1]) {
      const [p1, p2] = [0, 1, 2].filter((n) => n !== axis);
      let ring = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => (side << axis) | (u << p1) | (v << p2));
      const n = [a, b, c][axis].map((v) => (side ? v : -v)) as V3; // outward
      const e1 = [0, 1, 2].map((k) => P[ring[1]][k] - P[ring[0]][k]) as V3, e2 = [0, 1, 2].map((k) => P[ring[2]][k] - P[ring[1]][k]) as V3;
      const w = cross(e1, e2);
      if (w[0] * n[0] + w[1] * n[1] + w[2] * n[2] < 0) ring = ring.reverse();
      const oriented = ring.map((u, k) => { const e = edge(u, ring[(k + 1) % 4]); return add(`ORIENTED_EDGE('',*,*,#${e.id},${e.forward ? '.T.' : '.F.'})`); });
      const loop = add(`EDGE_LOOP('',(${oriented.map((x) => '#' + x).join(',')}))`);
      const bound = add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      const xDir = [0, 1, 2].map((k) => P[ring[1]][k] - P[ring[0]][k]) as V3;
      const plane = add(`PLANE('',AXIS2_PLACEMENT_3D('',#${pt(P[ring[0]])},#${dir(n)},#${dir(xDir)}))`);
      faces.push(add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
    }
  }
  const shell = add(`CLOSED_SHELL('',(${faces.map((x) => '#' + x).join(',')}))`);
  add(`MANIFOLD_SOLID_BREP('${name}',#${shell})`);
  // PLANE(.., AXIS2_PLACEMENT_3D(..)) inline is not valid STEP: write the placements as their own entities
  const text = lines.join('\n').replace(/AXIS2_PLACEMENT_3D\('',(#\d+),(#\d+),(#\d+)\)/g, (_m, p, z, x) => `#${add(`AXIS2_PLACEMENT_3D('',${p},${z},${x})`)}`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('box','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${text}\n${lines.slice(text.split('\n').length).join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

describe('boards in any orientation', () => {
  test('a 600 × 400 × 18 board standing on its edge is read lying flat in its own frame', () => {
    // thickness along X, 600 along Y, 400 along Z, at (100, 50, 0)
    const f = parseStep(boxStep('Side', [100, 50, 0], [18, 0, 0], [0, 600, 0], [0, 0, 400]));
    const { boards, other } = readBoards(f);
    expect(other).toEqual([]);
    expect(boards).toHaveLength(1);
    const [b] = boards;
    expect(b.thickness).toBeCloseTo(18, 6);
    expect(Math.abs(ringArea(b.part.outline))).toBeCloseTo(600 * 400, 3);
    expect(b.part.holes).toEqual([]);
    // the board frame's Z is the file's ±X, and its origin lies on one of the two big faces
    const z: V3 = [b.frame.r[2], b.frame.r[5], b.frame.r[8]];
    expect(Math.abs(z[0])).toBeCloseTo(1, 9);
    expect([100, 118]).toContainEqual(Math.round(b.frame.t[0]));
    // every outline corner maps back onto the box's footprint in the file
    for (const [x, y] of b.part.outline) {
      const p = applyXf(b.frame, [x, y, 0]);
      expect(p[1]).toBeGreaterThan(50 - 1e-6);
      expect(p[1]).toBeLessThan(650 + 1e-6);
      expect(p[2]).toBeGreaterThan(-1e-6);
      expect(p[2]).toBeLessThan(400 + 1e-6);
    }
  });

  test('a box lies on its largest sides: a square batten is a 20 mm board 600 long', () => {
    // (Only shapes like round rods, whose largest flat sides are their ends, come out "thicker than wide".)
    const { boards } = readBoards(parseStep(boxStep('Batten', [0, 0, 0], [20, 0, 0], [0, 20, 0], [0, 0, 600])));
    expect(boards).toHaveLength(1);
    expect(boards[0].thickness).toBeCloseTo(20, 6);
    expect(Math.abs(ringArea(boards[0].part.outline))).toBeCloseTo(20 * 600, 3);
  });
});
