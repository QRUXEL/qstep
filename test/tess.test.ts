import { describe, expect, test } from 'bun:test';
import { cylinderParam, coneParam, sphereParam, torusParam, splineParam, extrusionParam, revolutionParam, conicCurve, lineCurve, type Frame, type Param, type V3 } from '../src/index';
import { tessellate } from '../src/tess';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** A frame with its axis along `z` (any direction), x across it. */
function frameAlong(o: V3, z: V3): Frame {
  z = norm(z);
  const a: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = norm(sub(a, [z[0] * dot(a, z), z[1] * dot(a, z), z[2] * dot(a, z)]));
  return { o, x, y: cross(z, x), z };
}
/** n points round a circle in the frame's xy plane at height h, counter-clockwise about +z (or clockwise). */
function circle(F: Frame, r: number, h: number, n: number, ccw = true): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const t = ((ccw ? 1 : -1) * 2 * Math.PI * k) / n;
    out.push([0, 1, 2].map((i) => F.o[i] + F.z[i] * h + r * (Math.cos(t) * F.x[i] + Math.sin(t) * F.y[i])) as V3);
  }
  return out;
}

/** Total area, and the smallest dot of a triangle's normal with the expected outward direction there. */
function measure(m: { pos: number[]; idx: number[] }, outward: (p: V3) => V3) {
  let area = 0, worst = 1;
  for (let k = 0; k < m.idx.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => m.pos.slice(m.idx[k + j] * 3, m.idx[k + j] * 3 + 3) as V3);
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(...n);
    if (l < 1e-12) continue;
    area += l / 2;
    const mid: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    worst = Math.min(worst, dot(norm(n), norm(outward(mid))));
  }
  return { area, worst };
}

const radialOut = (F: Frame) => (p: V3): V3 => { const d = sub(p, F.o); const h = dot(d, F.z); return sub(d, [F.z[0] * h, F.z[1] * h, F.z[2] * h]); };
const opts = { maxAngle: Math.PI / 24 };

describe('meshing curved faces in (u, v)', () => {
  // a dowel lying along a tilted axis: the case that must not depend on the axis being Z
  for (const [name, axis] of [['upright', [0, 0, 1]], ['along X', [1, 0, 0]], ['tilted', [0.3, -0.8, 0.5]]] as [string, V3][]) {
    test(`full cylinder band, ${name}`, () => {
      const F = frameAlong([10, -5, 3], axis);
      const S = cylinderParam(F, 4);
      // outward normal: the bottom circle runs counter-clockwise seen from outside along +u, the top one back
      const m = tessellate(S, [circle(F, 4, 0, 48), circle(F, 4, 20, 48, false)], 1, opts)!;
      const r = measure(m, radialOut(F));
      expect(r.area).toBeGreaterThan(2 * Math.PI * 4 * 20 * 0.99);
      expect(r.area).toBeLessThan(2 * Math.PI * 4 * 20 * 1.001);
      expect(r.worst).toBeGreaterThan(0.95);
    });
    test(`drilled hole (normal inward), ${name}`, () => {
      const F = frameAlong([0, 0, 0], axis);
      const S = cylinderParam(F, 3);
      const m = tessellate(S, [circle(F, 3, 0, 40, false), circle(F, 3, 12, 40)], -1, opts)!;
      const r = measure(m, (p) => radialOut(F)(p).map((x) => -x) as V3);
      expect(r.area).toBeCloseTo(2 * Math.PI * 3 * 12, -0.5);
      expect(r.worst).toBeGreaterThan(0.95);
    });
  }

  test('cylinder with a seam edge (one loop round the band)', () => {
    const F = frameAlong([0, 0, 0], [0, 1, 1]);
    const S = cylinderParam(F, 5);
    const bottom = circle(F, 5, 0, 32), top = circle(F, 5, 10, 32, false);
    // bottom circle forward from the seam, up the seam, top circle back, down the seam
    const seamTop = top[0];
    const loop = [...bottom, bottom[0], seamTop, ...top.slice(1), seamTop];
    const m = tessellate(S, [loop], 1, opts)!;
    const r = measure(m, radialOut(F));
    expect(r.area).toBeCloseTo(2 * Math.PI * 5 * 10, -0.5);
    expect(r.worst).toBeGreaterThan(0.95);
  });

  test('a quarter wall between two straight edges', () => {
    const F = frameAlong([0, 0, 0], [1, 0, 0]);
    const S = cylinderParam(F, 10);
    const arc = (h: number, rev: boolean) => { const a: V3[] = []; for (let k = 0; k <= 16; k++) { const t = (Math.PI / 2) * k / 16; a.push(S.at(t, h)); } return rev ? a.reverse() : a; };
    const m = tessellate(S, [[...arc(0, false), ...arc(30, true)]], 1, opts)!;
    const r = measure(m, radialOut(F));
    expect(r.area).toBeCloseTo((Math.PI / 2) * 10 * 30, -0.5);
    expect(r.worst).toBeGreaterThan(0.95);
  });

  test('sphere cap running to the pole, and a hemisphere', () => {
    const F = frameAlong([1, 2, 3], [0.2, 0.3, 1]);
    const S = sphereParam(F, 8);
    // the upper hemisphere: bounded by the equator, counter-clockwise seen from above
    const m = tessellate(S, [circle(F, 8, 0, 64)], 1, opts)!;
    const out = (p: V3) => sub(p, F.o);
    const r = measure(m, out);
    expect(r.area).toBeGreaterThan(2 * Math.PI * 64 * 0.98);
    expect(r.area).toBeLessThan(2 * Math.PI * 64 * 1.001);
    expect(r.worst).toBeGreaterThan(0.9);
    // the lower hemisphere, same loop the other way round
    const lower = measure(tessellate(S, [circle(F, 8, 0, 64, false)], 1, opts)!, out);
    expect(lower.area).toBeCloseTo(r.area, 0);
    expect(lower.worst).toBeGreaterThan(0.9);
  });

  test('a ball with two holes drilled into it: the region goes all the way round', () => {
    const F = frameAlong([0, 0, 0], [0, 0, 1]);
    const R = 10, S = sphereParam(F, R);
    // two round holes of angular radius 0.4 rad, centred on the equator at u = 0 and u = π;
    // a hole runs clockwise seen from outside
    const hole = (u0: number): V3[] => {
      const c: V3 = [Math.cos(u0), Math.sin(u0), 0], e1: V3 = [-Math.sin(u0), Math.cos(u0), 0], e2: V3 = [0, 0, 1];
      const out: V3[] = [];
      for (let k = 0; k < 64; k++) {
        const t = (-2 * Math.PI * k) / 64, a = 0.4;
        const d = [0, 1, 2].map((i) => Math.cos(a) * c[i] + Math.sin(a) * (Math.cos(t) * e1[i] + Math.sin(t) * e2[i])) as V3;
        out.push([d[0] * R, d[1] * R, d[2] * R]);
      }
      return out;
    };
    const m = tessellate(S, [hole(0), hole(Math.PI)], 1, opts)!;
    const r = measure(m, (p) => p);
    const exact = 4 * Math.PI * R * R - 2 * (2 * Math.PI * R * R * (1 - Math.cos(0.4)));
    expect(r.area).toBeGreaterThan(exact * 0.98);
    expect(r.area).toBeLessThan(exact * 1.01);
    // slivers where a strip edge grazes a hole lean a little
    expect(r.worst).toBeGreaterThan(0.8);
  });

  test('a drill point: a cone from its apex to a circle', () => {
    const F = frameAlong([0, 0, 0], [0, 0, 1]);
    const a = (59 * Math.PI) / 180, S = coneParam(F, 4, a); // 118° point, radius 4 at v = 0, apex below
    const m = tessellate(S, [circle(F, 4, 0, 48, false)], 1, opts)!;
    const slant = 4 / Math.sin(a);
    const r = measure(m, (p) => { const d = radialOut(F)(p); const l = Math.hypot(...d) || 1; return [d[0] / l, d[1] / l, -Math.tan(a)] as V3; });
    expect(r.area).toBeGreaterThan(Math.PI * 4 * slant * 0.98);
    expect(r.area).toBeLessThan(Math.PI * 4 * slant * 1.01);
  });

  test('cone band', () => {
    const F = frameAlong([0, 0, 0], [0, 0, 1]);
    const a = Math.PI / 4, S = coneParam(F, 5, a);
    // radius 5 at v = 0, 10 at v = 5
    const m = tessellate(S, [circle(F, 5, 0, 48), circle(F, 10, 5, 48, false)], 1, opts)!;
    const slant = Math.hypot(5, 5);
    const r = measure(m, (p) => { const d = radialOut(F)(p); const l = Math.hypot(...d); return [d[0] / l, d[1] / l, -1] as V3; });
    expect(r.area).toBeCloseTo(Math.PI * (5 + 10) * slant, -0.5);
    expect(r.worst).toBeGreaterThan(0.9);
  });

  test('torus: a rounded-over edge round a disc (a quarter of the tube, all the way round)', () => {
    const F = frameAlong([0, 0, 0], [0, 0, 1]);
    const R = 20, r = 3, S = torusParam(F, R, r);
    // v from 0 (outermost) to π/2 (top): the outer circle radius R+r at height 0, the inner one radius R at height r
    const m = tessellate(S, [circle(F, R + r, 0, 96), circle(F, R, r, 96, false)], 1, opts)!;
    const exact = 2 * Math.PI * r * (R * (Math.PI / 2) + r); // Pappus: ∫ (R + r cos v) r dv over [0, π/2]
    const res = measure(m, (p) => { const d = radialOut(F)(p); const l = Math.hypot(...d); const ring: V3 = [d[0] / l * R, d[1] / l * R, 0]; return sub(p, ring); });
    expect(res.area).toBeGreaterThan(exact * 0.98);
    expect(res.area).toBeLessThan(exact * 1.01);
    expect(res.worst).toBeGreaterThan(0.9);
  });

  test('trimmed B-spline: a flat patch with a round hole', () => {
    // degree-1 patch over 0..100 × 0..100, z = 0
    const S = splineParam({ pu: 1, pv: 1, P: [[[0, 0, 0], [0, 100, 0]], [[100, 0, 0], [100, 100, 0]]], U: [0, 0, 1, 1], V: [0, 0, 1, 1], W: null });
    const outer: V3[] = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
    const hole = circle({ o: [50, 50, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, 20, 0, 64, false);
    const m = tessellate(S as Param, [outer, hole], 1, opts)!;
    const r = measure(m, () => [0, 0, 1]);
    expect(r.area).toBeCloseTo(10000 - Math.PI * 400, -1);
    expect(r.worst).toBeGreaterThan(0.99);
  });

  test('extrusion of a circle and revolution of a line give the cylinder', () => {
    const F = frameAlong([0, 0, 0], [0, 0, 1]);
    const ext = extrusionParam(conicCurve(F, 6, 6), [0, 0, 1], [0, 2 * Math.PI]);
    const band = [circle(F, 6, 0, 48), circle(F, 6, 15, 48, false)];
    const a = measure(tessellate(ext, band, 1, opts)!, radialOut(F));
    expect(a.area).toBeCloseTo(2 * Math.PI * 6 * 15, -0.5);
    expect(a.worst).toBeGreaterThan(0.95);
    // a line parallel to the axis at radius 6, turned round it
    const rev = revolutionParam(lineCurve([6, 0, 0], [0, 0, 1]), [0, 0, 0], [0, 0, 1], [-1, 16]);
    const b = measure(tessellate(rev, band, 1, opts)!, radialOut(F));
    expect(b.area).toBeCloseTo(2 * Math.PI * 6 * 15, -0.5);
  });
});
