// Display meshes for a whole file: one triangle mesh per placed solid, in
// model coordinates (mm), with the triangle range of every B-rep face, the
// colours and the assembly tree. Every face the reader understands is drawn;
// a face it can't read is left out with a warning instead of failing the file.
import { Enum, Ref, StepError, type Entity, type StepFile, type Value } from './parse';
import { readAssembly, solidInstances, applyXf, applyRot, type Assembly, type AssemblyNode, type V3, type Xf } from './assembly';
import { geometry } from './read';
import { meshFace } from './facemesh';

export interface MeshOptions {
  /** max chord error when sampling curves, mm */
  chordTol?: number;
  /** largest angle one segment of an arc, or one triangle of a curved face, may turn through (radians) */
  maxAngle?: number;
}

export interface FaceRange {
  /** B-rep face entity id */
  face: number;
  /** first and last triangle of the face in the body's index buffer */
  first: number; last: number;
  color?: V3;
}

export interface BodyMesh {
  /** the solid's entity id (shared by every placement of it) */
  solid: number;
  /** OpenCascade's name for the mesh: the product's, empty for the solids of a product with several */
  name: string;
  /** a name to show: the solid's own, else the product's */
  label: string;
  /** the assembly path to the product that holds the solid */
  path: AssemblyNode[];
  placement: Xf;
  color?: V3;
  pos: Float32Array; nor: Float32Array; idx: Uint32Array;
  faces: FaceRange[];
}

export interface MeshModel {
  assembly: Assembly;
  bodies: BodyMesh[];
  warnings: string[];
}

interface SolidMesh { pos: number[]; nor: number[]; idx: number[]; faces: FaceRange[] }

/** Meshes every placed solid of a parsed file. */
export function readMeshes(f: StepFile, opt: MeshOptions = {}): MeshModel {
  const assembly = readAssembly(f);
  const warnings = [...assembly.warnings];
  const maxAngle = opt.maxAngle ?? Math.PI / 12;
  const G = geometry(f, { chordTol: opt.chordTol ?? 0.05, maxArc: maxAngle, mmPer: assembly.mmPer, point: (p) => p, dir: (d) => d, lenient: true }, warnings);
  const E = f.entities;
  const get = (v: Value | undefined): Entity | undefined => (v instanceof Ref ? E.get(v.id) : undefined);
  const flipped = (v: Value | undefined) => v instanceof Enum && v.v === 'F';

  /** a solid's faces, each with whether it is used reversed (voids, oriented faces) */
  const solidFaces = (solid: Entity): { face: Entity; reversed: boolean }[] => {
    const out: { face: Entity; reversed: boolean }[] = [];
    const shell = (v: Value | undefined, reversed: boolean) => {
      let s = get(v);
      if (!s) return;
      if (s.type === 'ORIENTED_CLOSED_SHELL' || s.type === 'ORIENTED_OPEN_SHELL') { reversed = reversed !== flipped(s.args[3]); s = get(s.args[2]); if (!s) return; }
      for (const fv of (s.args[1] as Value[]) ?? []) {
        let fe = get(fv), rev = reversed;
        if (fe?.type === 'ORIENTED_FACE') { rev = rev !== flipped(fe.args[3]); fe = get(fe.args[2]); }
        if (fe) out.push({ face: fe, reversed: rev });
      }
    };
    shell(solid.args[1], false);
    if (solid.type === 'BREP_WITH_VOIDS') for (const v of (solid.args[2] as Value[]) ?? []) shell(v, true);
    return out;
  };

  const cache = new Map<number, SolidMesh>();
  const meshSolid = (id: number): SolidMesh => {
    const hit = cache.get(id);
    if (hit) return hit;
    const P: number[] = [], N: number[] = [], I: number[] = [], faces: FaceRange[] = [];
    const solid = E.get(id)!;
    for (const { face, reversed } of solidFaces(solid)) {
      const i0 = I.length, n0 = N.length;
      try { meshFace(G, face, P, N, I, { maxAngle }, warnings); }
      catch (err) {
        if (!(err instanceof StepError)) throw err;
        warnings.push(`Face #${face.id} was left out: ${err.message}`);
        // drop whatever the face had added
        I.length = i0; P.length = n0; N.length = n0;
        continue;
      }
      if (reversed) {
        for (let k = i0; k < I.length; k += 3) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
        for (let k = n0; k < N.length; k++) N[k] = -N[k];
      }
      if (I.length > i0) faces.push({ face: face.id, first: i0 / 3, last: I.length / 3 - 1, color: assembly.faceColors.get(face.id) });
    }
    const m = { pos: P, nor: N, idx: I, faces };
    cache.set(id, m);
    return m;
  };

  const bodies: BodyMesh[] = [];
  for (const inst of solidInstances(assembly)) {
    const m = meshSolid(inst.solid);
    const pos = new Float32Array(m.pos.length), nor = new Float32Array(m.nor.length);
    for (let k = 0; k < m.pos.length; k += 3) {
      const p = applyXf(inst.placement, [m.pos[k], m.pos[k + 1], m.pos[k + 2]]);
      const n = applyRot(inst.placement, [m.nor[k], m.nor[k + 1], m.nor[k + 2]]);
      pos[k] = p[0]; pos[k + 1] = p[1]; pos[k + 2] = p[2];
      nor[k] = n[0]; nor[k + 1] = n[1]; nor[k + 2] = n[2];
    }
    // a mirrored placement turns the triangles inside out: wind them back
    const r = inst.placement.r;
    const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
    const idx = Uint32Array.from(m.idx);
    if (det < 0) for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    const leaf = inst.path[inst.path.length - 1];
    bodies.push({
      solid: inst.solid,
      // as OpenCascade names its meshes (stored body ids are made from them): the product's name,
      // none for the solids of a product that has several
      name: leaf.solids.length > 1 ? '' : leaf.name || assembly.solidNames.get(inst.solid) || '',
      label: assembly.solidNames.get(inst.solid) || leaf.name || '',
      path: inst.path, placement: inst.placement,
      color: assembly.colors.get(inst.solid),
      pos, nor, idx, faces: m.faces,
    });
  }
  return { assembly, bodies, warnings };
}
