// Compares the STEP reader with Fusion's analysis of the same file (geom.json is
// what the old Python app derived from Fusion's mesh). Fixtures are private and
// git-ignored; the test is skipped when they are missing.
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { parseStep } from '../src/parse';
import { readModel } from '../src/brep';
import { union, difference, ringArea, type Poly } from '../src/geom/clip';

const dir = new URL('./fixtures/private/', import.meta.url);
const has = existsSync(new URL('skolbank_nested.step', dir));

const area = (ps: Poly[]) => ps.reduce((s, p) => s + p.reduce((a, r) => a + ringArea(r), 0), 0);
const xorArea = (a: Poly[], b: Poly[]) => area(difference(a, b)) + area(difference(b, a));

if (has) describe('STEP reader vs Fusion analysis (skolbank)', () => {
  const t0 = performance.now();
  const text = readFileSync(new URL('skolbank_nested.step', dir), 'utf8');
  const f = parseStep(text);
  const t1 = performance.now();
  const m = readModel(f);
  const t2 = performance.now();
  const geom = JSON.parse(readFileSync(new URL('geom.json', dir), 'utf8'));
  const an = JSON.parse(readFileSync(new URL('analysis.json', dir), 'utf8'));
  console.log(`parse ${(t1 - t0).toFixed(0)} ms, geometry ${(t2 - t1).toFixed(0)} ms, ${m.parts.length} parts, warnings: ${m.warnings.join(' | ') || 'none'}`);

  it('finds every part with its name and thickness', () => {
    expect(m.parts.length).toBe(an.parts.length);
    expect(m.parts.map((p) => p.label)).toEqual(an.parts.map((p: any) => p.label));
    for (const p of m.parts) {
      const a = an.parts[p.index];
      expect(Math.abs(p.zmin - a.zmin)).toBeLessThan(0.01);
      expect(Math.abs(p.zmax - a.zmax)).toBeLessThan(0.01);
    }
  });

  it('outlines, holes, top faces and pockets match within sampling error', () => {
    const rows: string[] = [];
    let worst = 0, bad = 0;
    for (const p of m.parts) {
      const k = p.index;
      const g = geom.parts[k];
      const mine: Poly[] = [[p.outline, ...p.holes]];
      const ref: Poly[] = [[g.outline, ...g.holes]];
      const per = p.perimeter;
      // area difference relative to perimeter = average boundary offset in mm
      const dOut = xorArea(mine, ref) / per;
      const refTop: Poly[] = g.top_faces.map(([o, hs]: [any, any[]]) => [o, ...hs]);
      const dTop = xorArea(p.topFaces, refTop) / per;
      const lvs = (arr: any[], from: string) => { const o: number[] = []; for (const d of arr.filter((x) => x.from === from).map((x) => x.depth).sort((a: number, b: number) => a - b)) if (!o.length || d - o[o.length - 1] > 0.015) o.push(d); return o; };
      const lv = (arr: any[], from: string) => lvs(arr, from).map((d) => d.toFixed(3)).join(',');
      const same = (a: number[], b: number[]) => a.length === b.length && a.every((d, k) => Math.abs(d - b[k]) < 0.015);
      const sameLevels = same(lvs(p.pockets, 'top'), lvs(g.pockets, 'top')) && same(lvs(p.pockets, 'bottom'), lvs(g.pockets, 'bottom'));
      let dPock = 0;
      for (const from of ['top', 'bottom'] as const) {
        const depths = [...new Set(g.pockets.filter((x: any) => x.from === from).map((x: any) => x.depth))];
        for (const d of depths) {
          const A: Poly[] = p.pockets.filter((x) => x.from === from && Math.abs(x.depth - (d as number)) < 0.015).map((x) => [x.poly, ...x.holes]);
          const B: Poly[] = g.pockets.filter((x: any) => x.from === from && x.depth === d).map((x: any) => [x.poly, ...x.holes]);
          dPock = Math.max(dPock, xorArea(union(A), union(B)) / per);
        }
      }
      worst = Math.max(worst, dOut, dTop, dPock);
      rows.push(`${p.label.padEnd(9)} outline ${dOut.toFixed(3)}  top ${dTop.toFixed(3)}  pockets ${dPock.toFixed(3)}  levels ${sameLevels ? 'same' : 'DIFFER ' + lv(p.pockets, 'top') + ' vs ' + lv(g.pockets, 'top')}`);
      if (!sameLevels) bad++;
    }
    console.log(rows.join('\n'));
    expect(bad).toBe(0);
    console.log('worst average boundary offset (mm):', worst.toFixed(3));
    // Fusion's mesh cuts large arcs with chords up to ~0.5 mm off (Wall 18/19); our arcs are
    // sampled to 0.01 mm. The average boundary offset over a whole part stays below 0.06 mm.
    expect(worst).toBeLessThan(0.06);
  });

  it('builds a closed triangle mesh per part', () => {
    for (const p of m.parts) {
      expect(p.mesh.idx.length % 3).toBe(0);
      expect(p.mesh.idx.length).toBeGreaterThan(12);
    }
  });

  it('3D mesh covers the whole top and bottom of every part', () => {
    const bad: string[] = [];
    for (const p of m.parts) {
      const { pos, idx } = p.mesh;
      let up = 0, dn = 0;
      for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
        const z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        const cz = ((pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a])) / 2;
        if (Math.abs(z - p.zmax) < 0.01) up += cz;
        if (Math.abs(z - p.zmin) < 0.01) dn -= cz;
      }
      const top = area(p.topFaces), bot = area(p.bottomFaces);
      if (Math.abs(up - top) > 1 + top * 1e-4 || Math.abs(dn - bot) > 1 + bot * 1e-4) bad.push(`${p.index} ${p.label}: top ${up.toFixed(0)}/${top.toFixed(0)}, bottom ${dn.toFixed(0)}/${bot.toFixed(0)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('Onshape part with B-spline edges and walls, drawn standing up', () => {
  it('reads the splines and turns the part to lie flat', () => {
    const m = readModel(parseStep(readFileSync(new URL('./fixtures/onshape_spline_baluster.step', import.meta.url), 'utf8')));
    expect(m.turned).toBe('y');
    expect(m.parts).toHaveLength(1);
    const p = m.parts[0];
    expect(p.thickness).toBeCloseTo(15, 2);
    expect(p.bbox[2] - p.bbox[0]).toBeCloseTo(160.86, 1);
    expect(p.bbox[3] - p.bbox[1]).toBeCloseTo(720.29, 1);
    expect(p.outline.length).toBeGreaterThan(100);       // the spline sides, not just the corners
    expect(m.warnings.some((w) => /neither flat nor vertical/.test(w))).toBe(false);
  });
});
