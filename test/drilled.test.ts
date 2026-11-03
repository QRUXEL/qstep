import { describe, expect, test } from 'bun:test';
import { parseStep, readBoards, readMeshes, ringArea } from '../src/index';
import { drilledBoard, dowel, placement } from './writer';

/** Volume enclosed by a mesh (positive when its triangles face out). */
function meshVolume(pos: ArrayLike<number>, idx: ArrayLike<number>) {
  let v = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

const turns: [string, ReturnType<typeof placement>][] = [
  ['as drawn', placement([0, 0, 1], 0)],
  ['standing on its edge', placement([1, 0, 0], Math.PI / 2, [50, -20, 300])],
  ['at an odd angle', placement([0.3, -0.7, 0.4], 1.1, [-200, 75, 12])],
];

describe('cylinders in any orientation', () => {
  for (const [name, X] of turns) {
    test(`a board with a through hole and a drilled edge hole, ${name}`, () => {
      const { text, volume } = drilledBoard(X);
      const f = parseStep(text);
      const { boards, other } = readBoards(f);
      expect(other).toEqual([]);
      expect(boards).toHaveLength(1);
      const [b] = boards;
      expect(b.thickness).toBeCloseTo(18, 4);
      // the footprint is the whole board (the edge hole is inside it) with the through hole in it
      expect(Math.abs(ringArea(b.part.outline))).toBeCloseTo(600 * 400, 0);
      expect(b.part.holes).toHaveLength(1);
      expect(Math.abs(ringArea(b.part.holes[0]))).toBeGreaterThan(Math.PI * 16 * 0.99);
      expect(Math.abs(ringArea(b.part.holes[0]))).toBeLessThan(Math.PI * 16 * 1.001);
      // the display mesh is closed and faces out: its volume is the board less both holes
      const m = readMeshes(f);
      expect(m.warnings).toEqual([]);
      expect(m.bodies).toHaveLength(1);
      expect(m.bodies[0].faces).toHaveLength(9);
      const v = meshVolume(m.bodies[0].pos, m.bodies[0].idx);
      // what the holes take out, within 2.5%: the mesh draws circles as 24-gons, about 1.1% short in area
      const removed = 600 * 400 * 18 - volume;
      expect(Math.abs(600 * 400 * 18 - v - removed) / removed).toBeLessThan(0.025);
    });

    test(`a round dowel, ${name}: not a board, meshed whole`, () => {
      const { text, volume } = dowel(X);
      const f = parseStep(text);
      const { boards, other } = readBoards(f);
      expect(boards).toHaveLength(0);
      expect(other).toHaveLength(1);
      const m = readMeshes(f);
      const v = meshVolume(m.bodies[0].pos, m.bodies[0].idx);
      expect(Math.abs(v - volume) / volume).toBeLessThan(0.01);
    });
  }
});
