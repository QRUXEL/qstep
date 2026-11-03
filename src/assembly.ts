// Assembly structure of a STEP file (AP203 / AP214 / AP242): products, their
// instances in parent assemblies with placements, the solids of each product
// and their colours. Knows nothing about faces; see brep.ts for the geometry.
//
//   NEXT_ASSEMBLY_USAGE_OCCURRENCE(id, name, desc, parent PD, child PD, ref)
//   CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(relationship, PRODUCT_DEFINITION_SHAPE(→ NAUO))
//   (REPRESENTATION_RELATIONSHIP(.., child SR, parent SR)
//    REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(ITEM_DEFINED_TRANSFORMATION(.., item1, item2)) ..)
//   SHAPE_DEFINITION_REPRESENTATION(PRODUCT_DEFINITION_SHAPE(→ PD), SR)
//   SHAPE_REPRESENTATION_RELATIONSHIP(.., SR, ADVANCED_BREP_SHAPE_REPRESENTATION(.., (solids), ctx))
import { Ref, Enum, decodeString, type Entity, type StepFile, type Value } from './parse';

export type V3 = [number, number, number];
/** A rigid placement: p' = R·p + t, R row-major 3×3. Lengths in mm. */
export interface Xf { r: number[]; t: V3 }

export interface AssemblyNode {
  /** product name */
  name: string;
  /** the instance's own name in its parent (NAUO name), when it has one */
  instance?: string;
  /** product definition entity id (shared by every instance of the product) */
  product: number;
  /** where this instance sits in the whole model (file root = identity) */
  placement: Xf;
  /** solid entity ids (MANIFOLD_SOLID_BREP / BREP_WITH_VOIDS) of this product itself */
  solids: number[];
  children: AssemblyNode[];
}

export interface Assembly {
  /** the top-level products (usually one) */
  roots: AssemblyNode[];
  /** solid id → colour, 0..1 */
  colors: Map<number, V3>;
  /** face id → colour, for files that colour faces rather than solids */
  faceColors: Map<number, V3>;
  /** solid id → name */
  solidNames: Map<number, string>;
  /** millimetres per file length unit */
  mmPer: number;
  warnings: string[];
}

export const IDENTITY: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function applyXf(x: Xf, p: V3): V3 {
  const r = x.r;
  return [r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + x.t[0], r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + x.t[1], r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + x.t[2]];
}
export function applyRot(x: Xf, v: V3): V3 {
  const r = x.r;
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}
/** a then b: p ↦ b(a(p)) */
export function composeXf(b: Xf, a: Xf): Xf {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(b.r[i * 3] * a.r[j] + b.r[i * 3 + 1] * a.r[3 + j] + b.r[i * 3 + 2] * a.r[6 + j]);
  return { r, t: applyXf(b, a.t) };
}
export function invertXf(x: Xf): Xf {
  const r = [x.r[0], x.r[3], x.r[6], x.r[1], x.r[4], x.r[7], x.r[2], x.r[5], x.r[8]];
  const t = applyRot({ r, t: [0, 0, 0] }, x.t);
  return { r, t: [-t[0], -t[1], -t[2]] };
}

const SOLID_TYPES = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS'];

/** Millimetres per length unit of the file (the first LENGTH_UNIT). */
export function lengthUnit(f: StepFile): { mmPer: number; unit: string } {
  for (const id of f.byType.get('LENGTH_UNIT') || []) {
    const e = f.entities.get(id)!;
    const si = e.parts?.SI_UNIT;
    if (si) {
      const prefix = si[0] instanceof Enum ? si[0].v : null;
      const mmPer = prefix === 'MILLI' ? 1 : prefix === 'CENTI' ? 10 : prefix === 'DECI' ? 100 : prefix === null ? 1000 : prefix === 'MICRO' ? 0.001 : 1;
      return { mmPer, unit: prefix ? prefix.toLowerCase() + 'metre' : 'metre' };
    }
    const conv = e.parts?.CONVERSION_BASED_UNIT;
    if (conv && typeof conv[0] === 'string') {
      const name = conv[0].toUpperCase();
      if (name.includes('INCH')) return { mmPer: 25.4, unit: 'inch' };
      if (name.includes('FOOT')) return { mmPer: 304.8, unit: 'foot' };
    }
  }
  return { mmPer: 1, unit: 'mm' };
}

export function readAssembly(f: StepFile): Assembly {
  const E = f.entities;
  const ids = (type: string) => f.byType.get(type) || [];
  const get = (v: Value | undefined): Entity | undefined => (v instanceof Ref ? E.get(v.id) : undefined);
  const refId = (v: Value | undefined) => (v instanceof Ref ? v.id : -1);
  const text = (v: Value | undefined) => (typeof v === 'string' ? decodeString(v).trim() : '');
  const { mmPer } = lengthUnit(f);
  const warnings: string[] = [];

  // ---- placements
  const frame = (v: Value | undefined): Xf | null => {
    const e = get(v);
    if (!e || e.type !== 'AXIS2_PLACEMENT_3D') return null;
    const c = (get(e.args[1])?.args[1] as number[]) ?? [0, 0, 0];
    const dir = (w: Value | undefined, fallback: V3): V3 => {
      const d = get(w)?.args[1] as number[] | undefined;
      if (!d) return fallback;
      const l = Math.hypot(d[0], d[1], d[2] ?? 0) || 1;
      return [d[0] / l, d[1] / l, (d[2] ?? 0) / l];
    };
    const z = dir(e.args[2], [0, 0, 1]);
    let x = dir(e.args[3], Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    const k = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = [x[0] - k * z[0], x[1] - k * z[1], x[2] - k * z[2]];
    const lx = Math.hypot(...x) || 1;
    x = [x[0] / lx, x[1] / lx, x[2] / lx];
    const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    // columns x, y, z: local → file coordinates
    return { r: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: [c[0] * mmPer, c[1] * mmPer, (c[2] ?? 0) * mmPer] };
  };

  // ---- product definition → shape representation → solids
  const pdsTarget = new Map<number, number>(); // PRODUCT_DEFINITION_SHAPE → its definition (PD or NAUO)
  for (const id of ids('PRODUCT_DEFINITION_SHAPE')) pdsTarget.set(id, refId(E.get(id)!.args[2]));
  const shapeOf = new Map<number, number>(); // PD → SR
  for (const id of ids('SHAPE_DEFINITION_REPRESENTATION')) {
    const e = E.get(id)!;
    const pd = pdsTarget.get(refId(e.args[0]));
    if (pd !== undefined && !shapeOf.has(pd)) shapeOf.set(pd, refId(e.args[1]));
  }
  // plain (no transformation) links between representations: SR ↔ its B-rep representation
  const linked = new Map<number, number[]>();
  const link = (a: number, b: number) => { linked.set(a, [...(linked.get(a) || []), b]); linked.set(b, [...(linked.get(b) || []), a]); };
  for (const id of ids('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const e = E.get(id)!;
    if (e.parts?.REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION) continue;
    const rr = e.parts?.REPRESENTATION_RELATIONSHIP ?? e.args;
    link(refId(rr[2]), refId(rr[3]));
  }
  const repItems = (rep: number) => ((E.get(rep)?.args[1] ?? E.get(rep)?.parts?.REPRESENTATION?.[1]) as Value[] | undefined) ?? [];
  const solidsOfRep = (rep: number): number[] => {
    const out = new Set<number>();
    const seen = new Set<number>();
    const visit = (r: number, depth: number) => {
      if (seen.has(r) || depth > 3) return;
      seen.add(r);
      for (const item of repItems(r)) {
        const e = get(item);
        if (e && SOLID_TYPES.some((t) => e.type === t || e.parts?.[t])) out.add(e.id);
      }
      for (const other of linked.get(r) || []) visit(other, depth + 1);
    };
    visit(rep, 0);
    return [...out];
  };

  // ---- names
  const productName = (pd: number) => {
    const formation = get(E.get(pd)?.args[2]);
    const product = get(formation?.args[2]);
    return text(product?.args[1]) || text(product?.args[0]) || `Product #${pd}`;
  };

  // ---- instances: parent PD → (NAUO, child PD, placement in the parent)
  const placementOf = new Map<number, Xf>(); // NAUO → child-to-parent placement
  for (const id of ids('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const e = E.get(id)!;
    const nauo = pdsTarget.get(refId(e.args[1]));
    const rel = get(e.args[0]);
    if (nauo === undefined || !rel) continue;
    const rr = rel.parts?.REPRESENTATION_RELATIONSHIP ?? rel.args;
    const xfEnt = get(rel.parts?.REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION?.[0]);
    if (!xfEnt || xfEnt.type !== 'ITEM_DEFINED_TRANSFORMATION') {
      warnings.push(`Instance #${nauo}: placement ${xfEnt?.type ?? 'missing'} is not supported; read in place.`);
      continue;
    }
    const a1 = frame(xfEnt.args[2]), a2 = frame(xfEnt.args[3]);
    if (!a1 || !a2) continue;
    // item 1 sits in rep_1, item 2 in rep_2: the instance maps rep_1 onto rep_2.
    let xf = composeXf(a2, invertXf(a1));
    const nauoEnt = E.get(nauo);
    const childRep = shapeOf.get(refId(nauoEnt?.args[4]));
    // rep_1 is normally the child's representation; some writers swap them
    if (childRep !== undefined && refId(rr[3]) === childRep && refId(rr[2]) !== childRep) xf = invertXf(xf);
    placementOf.set(nauo, xf);
  }
  const childrenOf = new Map<number, { nauo: number; child: number }[]>();
  const isChild = new Set<number>();
  for (const id of ids('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const e = E.get(id)!;
    const parent = refId(e.args[3]), child = refId(e.args[4]);
    childrenOf.set(parent, [...(childrenOf.get(parent) || []), { nauo: id, child }]);
    isChild.add(child);
  }

  const build = (pd: number, placement: Xf, instance: string | undefined, path: Set<number>): AssemblyNode => {
    const rep = shapeOf.get(pd);
    const node: AssemblyNode = {
      name: productName(pd), instance, product: pd, placement,
      solids: rep !== undefined ? solidsOfRep(rep) : [],
      children: [],
    };
    if (path.has(pd)) { warnings.push(`Product #${pd} contains itself; the loop was cut.`); return node; }
    const next = new Set(path).add(pd);
    for (const { nauo, child } of childrenOf.get(pd) || []) {
      const local = placementOf.get(nauo) ?? IDENTITY;
      const name = text(E.get(nauo)!.args[1]);
      node.children.push(build(child, composeXf(placement, local), name || undefined, next));
    }
    // a product's solids that its children already hold (some writers list both) belong to the children
    if (node.children.length) {
      const below = new Set(allSolids(node.children));
      node.solids = node.solids.filter((s) => !below.has(s));
    }
    return node;
  };
  const roots = ids('PRODUCT_DEFINITION').filter((pd) => !isChild.has(pd) && (shapeOf.has(pd) || childrenOf.has(pd))).map((pd) => build(pd, IDENTITY, undefined, new Set()));
  // Files without product structure: every solid at the top level.
  if (!roots.length) {
    const solids = SOLID_TYPES.flatMap(ids);
    roots.push({ name: '', product: -1, placement: IDENTITY, solids, children: [] });
  }

  // ---- colours: the first COLOUR_RGB under a styled item that points at a solid
  const colors = new Map<number, V3>();
  const faceColors = new Map<number, V3>();
  const findColor = (v: Value | undefined, depth: number): V3 | null => {
    if (depth > 16) return null;
    if (Array.isArray(v)) { for (const x of v) { const c = findColor(x, depth + 1); if (c) return c; } return null; }
    const e = get(v);
    if (!e) return null;
    if (e.type === 'COLOUR_RGB') return [Number(e.args[1]), Number(e.args[2]), Number(e.args[3])];
    for (const a of e.args) { const c = findColor(a, depth + 1); if (c) return c; }
    return null;
  };
  for (const type of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']) {
    for (const id of ids(type)) {
      const e = E.get(id)!;
      const target = get(e.args[2]);
      if (!target) continue;
      const solid = SOLID_TYPES.includes(target.type);
      if (solid ? colors.has(target.id) : target.type !== 'ADVANCED_FACE' || faceColors.has(target.id)) continue;
      const c = findColor(e.args[1], 0);
      if (c) (solid ? colors : faceColors).set(target.id, c);
    }
  }
  const solidNames = new Map<number, string>();
  for (const id of SOLID_TYPES.flatMap(ids)) solidNames.set(id, text(E.get(id)!.args[0]));
  return { roots, colors, faceColors, solidNames, mmPer, warnings };
}

export function allSolids(nodes: AssemblyNode[]): number[] {
  return nodes.flatMap((n) => [...n.solids, ...allSolids(n.children)]);
}

/** Every placed solid: the solid and where it sits in the whole model, in tree order. */
export function solidInstances(a: Assembly): { solid: number; placement: Xf; path: AssemblyNode[] }[] {
  const out: { solid: number; placement: Xf; path: AssemblyNode[] }[] = [];
  const walk = (n: AssemblyNode, path: AssemblyNode[]) => {
    const here = [...path, n];
    for (const s of n.solids) out.push({ solid: s, placement: n.placement, path: here });
    for (const c of n.children) walk(c, here);
  };
  for (const r of a.roots) walk(r, []);
  return out;
}
