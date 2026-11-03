// B-rep reader for 2.5D sheet parts (what ManualNest and similar nesting tools
// export, or a CAD system like Onshape): planes, cylinders, cones and B-spline
// surfaces bounded by lines, circles, ellipses and B-spline curves.
// Anything else is refused with a clear message instead of being guessed.
//
// Output per solid: top/bottom z, footprint outline + through-holes, pocket
// levels (cumulative, from the top and from the bottom), top/bottom faces and a
// triangle mesh for the 3D view.
import { Ref, Enum, Typed, StepError, type StepFile, type Value, type Entity } from './parse';
import { union, simplify, round3, ringArea, type Poly, type Ring, type Pt } from './geom/clip';
import { surfaceDomain, surfaceNormal, type Surface } from './nurbs';
import { geometry } from './read';
import { meshFace } from './facemesh';
import type { Frame } from './surface';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface PocketLevel {
  z: number; depth: number; area: number; poly: Ring; holes: Ring[]; from: 'top' | 'bottom';
}
export interface PartMesh { pos: Float32Array; nor: Float32Array; idx: Uint32Array }
export interface Part {
  index: number;
  label: string;
  zmin: number; zmax: number; thickness: number;
  bbox: [number, number, number, number];
  outline: Ring;
  holes: Ring[];
  pockets: PocketLevel[];
  topFaces: Poly[];
  bottomFaces: Poly[];
  /** footprint area and perimeter, used to match parts when a STEP file is replaced */
  area: number;
  perimeter: number;
  mesh: PartMesh;
}
export interface StepModel {
  source: string;               // FILE_NAME / originating system
  unit: string;
  parts: Part[];
  bbox: [number, number, number, number];
  thickness: number;
  warnings: string[];
  /** the file's parts stood on their side and were turned to lie flat: X or Y was the thin axis */
  turned?: 'x' | 'y';
}

export interface ReadOptions {
  /** max chord error when sampling arcs, mm */
  chordTol?: number;
  /** z tolerance for "flat" and "at the top" tests, mm */
  zTol?: number;
}

const SUPPORTED_SURFACES = new Set(['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE']);

export function readModel(f: StepFile, opt: ReadOptions = {}): StepModel {
  const chordTol = opt.chordTol ?? 0.01;
  const zTol = opt.zTol ?? 0.02;
  const E = f.entities;
  const warnings: string[] = [];

  const ent = (v: Value, ctx: string): Entity => {
    if (!(v instanceof Ref)) throw new StepError(`${ctx}: expected a reference`);
    const e = E.get(v.id);
    if (!e) throw new StepError(`${ctx}: #${v.id} is missing from the file`);
    return e;
  };
  const num = (v: Value) => (v instanceof Typed ? Number(v.args[0]) : Number(v));
  const bool = (v: Value) => v instanceof Enum && v.v === 'T';

  // ---- units: length unit of the geometric context → millimetres
  let mmPer = 1, unit = 'mm';
  for (const id of f.byType.get('LENGTH_UNIT') || []) {
    const e = E.get(id)!;
    const si = e.parts?.SI_UNIT;
    if (si) {
      const prefix = si[0] instanceof Enum ? si[0].v : null;
      mmPer = prefix === 'MILLI' ? 1 : prefix === 'CENTI' ? 10 : prefix === 'DECI' ? 100 : prefix === null ? 1000 : prefix === 'MICRO' ? 0.001 : 1;
      unit = prefix ? prefix.toLowerCase() + 'metre' : 'metre';
    }
    const conv = e.parts?.CONVERSION_BASED_UNIT;
    if (conv && typeof conv[0] === 'string') {
      const name = conv[0].toUpperCase();
      if (name.includes('INCH')) { mmPer = 25.4; unit = 'inch'; }
      else if (name.includes('FOOT')) { mmPer = 304.8; unit = 'foot'; }
    }
    break;
  }

  // ---- lying flat: boards are read with their thickness along Z. A part drawn standing up
  // (Onshape's Front plane, say) is turned so its thinnest direction becomes Z.
  let turn = (p: V3): V3 => p;
  let turned: 'x' | 'y' | undefined;
  {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of f.byType.get('VERTEX_POINT') || []) {
      const pe = E.get(id)!, c = E.get((pe.args[1] as Ref).id)?.args[1] as number[] | undefined;
      if (!c) continue;
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] ?? 0); hi[k] = Math.max(hi[k], c[k] ?? 0); }
    }
    const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
    if (ext.every(Number.isFinite)) {
      const thin = ext.indexOf(Math.min(...ext));
      if (thin !== 2 && ext[thin] < 0.5 * ext[2]) {
        // proper rotations: Y thin -> (x, z, -y); X thin -> (y, z, x)
        turn = thin === 1 ? (p) => [p[0], p[2], -p[1]] : (p) => [p[1], p[2], p[0]];
        turned = thin === 1 ? 'y' : 'x';
        warnings.push(`The parts stand on their side in the file (thinnest along ${'XYZ'[thin]}); they were turned to lie flat.`);
      }
    }
  }

  // ---- solids
  const brepIds = [...(f.byType.get('MANIFOLD_SOLID_BREP') || []), ...(f.byType.get('BREP_WITH_VOIDS') || [])];
  if (!brepIds.length) {
    const shells = f.byType.get('SHELL_BASED_SURFACE_MODEL');
    throw new StepError(shells ? 'The file holds surface models, not solids. Export the parts as solid bodies.' : 'No solid bodies were found in the file.');
  }
  const unsupportedXf = (f.byType.get('ITEM_DEFINED_TRANSFORMATION') || []).length;
  if (unsupportedXf) warnings.push(`The file contains ${unsupportedXf} assembly placement(s); parts are read at their stored positions.`);
  const parts = solidParts(f, brepIds, { chordTol, zTol, mmPer, point: turn, dir: turn }, warnings);

  const bx = parts.map((p) => p.bbox);
  const fn = f.header.FILE_NAME;
  return {
    source: fn ? String((fn[3] as Value[])?.[0] ?? fn[0] ?? '') : '',
    unit, parts, warnings, turned,
    bbox: [Math.min(...bx.map((b) => b[0])), Math.min(...bx.map((b) => b[1])), Math.max(...bx.map((b) => b[2])), Math.max(...bx.map((b) => b[3]))],
    thickness: Math.max(...parts.map((p) => p.thickness)),
  };
}

/** How a solid is read: file points (already in mm) and directions into the frame its faces are analysed in. */
export interface SolidFrame {
  point: (p: V3) => V3;
  dir: (d: V3) => V3;
}

/**
 * Reads solids into parts, with their thickness along Z of the given frame:
 * every face, the 2.5D analysis (outline, holes, pockets, top and bottom
 * faces) and a mesh, all in that frame. Throws a StepError for a solid it
 * can't read as a board.
 */
export function solidParts(f: StepFile, ids: number[], o: { chordTol: number; zTol: number; mmPer: number } & SolidFrame, warnings: string[]): Part[] {
  const { chordTol, zTol, mmPer } = o;
  const turn = o.point, turnDir = o.dir;
  const G = geometry(f, { chordTol, mmPer, point: turn, dir: turnDir }, warnings);
  const { E, ent, num, bool, frame, splineSurface, loopPoints, segs } = G;

  // ---- faces
  interface Face {
    id: number; kind: 'plane' | 'cylinder' | 'cone' | 'spline' | 'other';
    loops: V3[][]; outer: number;   // index of the outer loop
    n?: V3;                          // plane normal (oriented)
    nz: number;                      // representative normal z (sign tells up/down)
    z: number;                       // plane z (horizontal planes)
    flat: boolean;                   // horizontal plane
    surf: { F: Frame; r?: number; ang?: number; sign: number; S?: Surface };
  }
  // Mean normal z over a face's boundary points: a side face that leans up
  // (a rounded-over top edge) counts towards the footprint, one that faces
  // sideways (a hole drilled into the edge) doesn't.
  const meanNz = (loops: V3[][], normalAt: (p: V3) => V3) => {
    const pts = loops.flat();
    const nz = pts.reduce((sum, p) => sum + normalAt(p)[2], 0) / Math.max(1, pts.length);
    return Math.abs(nz) < 0.02 ? 0 : nz;
  };
  const face = (e: Entity): Face => {
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') throw new StepError(`unsupported face ${e.type} (#${e.id})`);
    const s = ent(e.args[2], 'surface');
    const sp = splineSurface(s);
    if (sp) return splineFace(e, sp);
    const sign = bool(e.args[3]) ? 1 : -1;
    if (!SUPPORTED_SURFACES.has(s.type)) return otherFace(e, s, sign);
    const F = frame(s.args[1]);
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      const pts = loopPoints(b.args[1]);
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(pts);
    }
    const all = loops.flat();
    const zs = all.map((p) => p[2]);
    const flatZ = Math.max(...zs) - Math.min(...zs) < zTol;
    if (outer < 0 && loops.length > 1) {
      // only FACE_BOUNDs (allowed by the standard): the outer loop is the one
      // enclosing the largest area, measured in the face's own plane
      const ax: V3 = Math.abs(F.z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = norm(cross(ax, F.z)), w = cross(F.z, u);
      const areaOf = (l: V3[]) => Math.abs(ringArea(l.map((p) => [dot(p, u), dot(p, w)] as Pt)));
      if (s.type === 'PLANE') loops.forEach((l, k) => { if (outer < 0 || areaOf(l) > areaOf(loops[outer])) outer = k; });
    }
    if (s.type === 'PLANE') {
      const n = scale(F.z, sign);
      return { id: e.id, kind: 'plane', loops, outer, n, nz: n[2], z: zs.reduce((a, b) => a + b, 0) / zs.length, flat: Math.abs(n[2]) > 0.999 && flatZ, surf: { F, sign } };
    }
    const r = num(s.args[2]) * mmPer;
    const ang = s.type === 'CONICAL_SURFACE' ? num(s.args[3]) : 0; // semi-angle (radians in plane-angle unit)
    if (Math.abs(F.z[2]) < 0.999) {
      // Not straight through the board (a hole into an edge, a rounded-over edge): a side face.
      const normalAt = (p: V3): V3 => {
        const d = sub(p, F.o);
        const radial = norm(sub(d, scale(F.z, dot(d, F.z))));
        return scale(ang ? norm(sub(radial, scale(F.z, Math.tan(ang)))) : radial, sign);
      };
      return { id: e.id, kind: ang ? 'cone' : 'cylinder', loops, outer, nz: meanNz(loops, normalAt), z: 0, flat: false, surf: { F, r, ang: ang || undefined, sign } };
    }
    if (s.type === 'CYLINDRICAL_SURFACE') return { id: e.id, kind: 'cylinder', loops, outer, nz: 0, z: 0, flat: false, surf: { F, r, sign } };
    // outward normal of a cone at u=0: x - tan(a) * axis
    const nz = dot(norm(sub(F.x, scale(F.z, Math.tan(ang)))), [0, 0, 1]) * sign;
    return { id: e.id, kind: 'cone', loops, outer, nz, z: 0, flat: false, surf: { F, r, ang, sign } };
  };

  /** Tori, spheres and other surfaces (rounded corners, hardware): side faces, no mesh yet. */
  const otherFace = (e: Entity, s: Entity, sign: number): Face => {
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(loopPoints(b.args[1]));
    }
    const F = s.args[1] instanceof Ref && E.get(s.args[1].id)?.type === 'AXIS2_PLACEMENT_3D' ? frame(s.args[1]) : null;
    let normalAt: ((p: V3) => V3) | null = null;
    if (F && s.type === 'SPHERICAL_SURFACE') normalAt = (p) => scale(norm(sub(p, F.o)), sign);
    if (F && s.type === 'TOROIDAL_SURFACE') {
      const R = num(s.args[2]) * mmPer;
      normalAt = (p) => {
        const d = sub(p, F.o);
        const ring = add(F.o, scale(norm(sub(d, scale(F.z, dot(d, F.z)))), R));
        return scale(norm(sub(p, ring)), sign);
      };
    }
    if (!normalAt) warnings.push(`Surface type ${s.parts ? Object.keys(s.parts).join(' + ') : s.type} (face #${e.id}) is read as a side face.`);
    return { id: e.id, kind: 'other', loops, outer, nz: normalAt ? meanNz(loops, normalAt) : 0, z: 0, flat: false, surf: { F: F ?? { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, sign } };
  };

  /** A B-spline face: a side wall straight through the board, or a flat face. */
  const splineFace = (e: Entity, S: Surface): Face => {
    const sign = bool(e.args[3]) ? 1 : -1;
    const loops: V3[][] = [];
    let outer = -1;
    for (const bv of e.args[1] as Value[]) {
      const b = ent(bv, 'bound');
      if (b.type === 'FACE_OUTER_BOUND') outer = loops.length;
      loops.push(loopPoints(b.args[1]));
    }
    const [u0, u1, v0, v1] = surfaceDomain(S);
    let minNz = 1, maxNz = -1, sumNz = 0, n0: V3 = [0, 0, 1];
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
      const n = surfaceNormal(S, u0 + ((u1 - u0) * i) / 6, v0 + ((v1 - v0) * j) / 6);
      minNz = Math.min(minNz, n[2] * sign); maxNz = Math.max(maxNz, n[2] * sign); sumNz += n[2] * sign;
      if (i === 3 && j === 3) n0 = scale(n, sign);
    }
    const zs = loops.flat().map((p) => p[2]);
    const flatZ = Math.max(...zs) - Math.min(...zs) < zTol;
    const F: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    if (flatZ && Math.abs(minNz) > 0.999 && Math.sign(minNz) === Math.sign(maxNz)) {
      const n: V3 = [0, 0, Math.sign(minNz)];
      if (outer < 0) loops.forEach((l, k) => { if (outer < 0 || Math.abs(ringArea(l.map((p) => [p[0], p[1]] as Pt))) > Math.abs(ringArea(loops[outer].map((p) => [p[0], p[1]] as Pt)))) outer = k; });
      return { id: e.id, kind: 'plane', loops, outer, n, nz: n[2], z: zs.reduce((a, b) => a + b, 0) / zs.length, flat: true, surf: { F, sign } };
    }
    if (Math.max(Math.abs(minNz), Math.abs(maxNz)) > 0.02) {
      warnings.push(`A curved face that is neither flat nor vertical was found (face #${e.id}); it is read as a side wall, so the part may come out slightly wrong.`);
    }
    return { id: e.id, kind: 'spline', loops, outer, n: n0, nz: Math.abs(sumNz / 49) < 0.02 ? 0 : sumNz / 49, z: 0, flat: false, surf: { F, sign, S } };
  };

  const proj = (loop: V3[]): Ring => loop.map((p) => [p[0], p[1]] as Pt);
  const facePoly = (fc: Face): Poly => {
    const rings = fc.loops.map(proj).filter((r) => r.length >= 3);
    if (!rings.length) return [];
    let oi = fc.outer >= 0 ? fc.outer : 0;
    if (fc.outer < 0) rings.forEach((r, k) => { if (Math.abs(ringArea(r)) > Math.abs(ringArea(rings[oi]))) oi = k; });
    return [rings[oi], ...rings.filter((_, k) => k !== oi)];
  };

  // ---- tessellation for the 3D view
  const meshOne = (fc: Face, P: number[], N: number[], I: number[]) => {
    meshFace(G, E.get(fc.id)!, P, N, I, { maxAngle: Math.PI / 12 }, warnings);
  };

  // ---- solids
  const solids: { name: string; faces: Face[] }[] = [];
  for (const id of ids) {
    const b = E.get(id)!;
    const shell = ent(b.args[1], 'shell');
    const faces = (shell.args[1] as Value[]).map((fv) => face(ent(fv, 'face')));
    solids.push({ name: typeof b.args[0] === 'string' && b.args[0] ? b.args[0] : `Body ${solids.length + 1}`, faces });
  }

  // ---- 2D geometry per solid
  const parts: Part[] = solids.map((s, index) => {
    const allZ = s.faces.flatMap((fc) => fc.loops.flat().map((p) => p[2]));
    const zmin = Math.min(...allZ), zmax = Math.max(...allZ);
    const up = s.faces.filter((fc) => fc.nz > 1e-6);
    const flatUp = up.filter((fc) => fc.flat);
    const flatDn = s.faces.filter((fc) => fc.flat && fc.nz < -1e-6);
    const tidy = (ps: Poly[], minArea = 1) => simplify(union(ps, minArea), 0.003).map(round3);

    // footprint: every face that looks up (also cones and chamfers)
    const sil = tidy(up.map(facePoly));
    const main = sil.reduce<Poly | null>((m, p) => (!m || ringArea(p[0]) > ringArea(m[0]) ? p : m), null);
    if (!main) throw new StepError(`Part "${s.name}" has no faces that look up; is it a closed solid?`);
    if (sil.length > 1) warnings.push(`Part "${s.name}" has ${sil.length - 1} separate piece(s) besides the main one; only the largest is used as its outline.`);

    const levels = (faces: Face[], fromTop: boolean): PocketLevel[] => {
      const zs = groupZ(faces.map((fc) => fc.z)).sort((a, b) => (fromTop ? b - a : a - b));
      const out: PocketLevel[] = [];
      for (const z of zs) {
        const sel = faces.filter((fc) => (fromTop ? fc.z <= z + zTol / 2 : fc.z >= z - zTol / 2));
        for (const p of tidy(sel.map(facePoly))) {
          out.push({ z: Math.round(z * 1000) / 1000, depth: Math.round((fromTop ? zmax - z : z - zmin) * 1000) / 1000,
            area: Math.round(Math.abs(ringArea(p[0]) + p.slice(1).reduce((a, r) => a + ringArea(r), 0)) * 10) / 10,
            poly: p[0], holes: p.slice(1).filter((r) => Math.abs(ringArea(r)) > 0.5), from: fromTop ? 'top' : 'bottom' });
        }
      }
      return out;
    };
    const pockets = [
      ...levels(flatUp.filter((fc) => fc.z < zmax - zTol), true),
      ...levels(flatDn.filter((fc) => fc.z > zmin + zTol), false),
    ];
    const topFaces = tidy(flatUp.filter((fc) => fc.z > zmax - zTol).map(facePoly));
    const bottomFaces = tidy(flatDn.filter((fc) => fc.z < zmin + zTol).map(facePoly));

    const P: number[] = [], N: number[] = [], I: number[] = [];
    for (const fc of s.faces) meshOne(fc, P, N, I);

    const xs = main[0].map((p) => p[0]), ys = main[0].map((p) => p[1]);
    let per = 0;
    for (let k = 0; k < main[0].length; k++) {
      const a = main[0][k], b = main[0][(k + 1) % main[0].length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return {
      index, label: s.name, zmin: r3(zmin), zmax: r3(zmax), thickness: r3(zmax - zmin),
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      outline: main[0], holes: main.slice(1).filter((r) => Math.abs(ringArea(r)) > 0.5),
      pockets, topFaces, bottomFaces,
      area: Math.round(Math.abs(ringArea(main[0])) * 10) / 10, perimeter: Math.round(per * 100) / 100,
      mesh: { pos: new Float32Array(P), nor: new Float32Array(N), idx: new Uint32Array(I) },
    };
  });

  return parts;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** distinct z levels, merging values closer than 0.005 mm */
function groupZ(zs: number[]): number[] {
  const out: number[] = [];
  for (const z of [...zs].sort((a, b) => a - b)) if (!out.length || z - out[out.length - 1] > 0.005) out.push(z);
  return out;
}
