// Usage: bun tools/frame.ts <file.step> <solid name> — the board frame check for one solid
import { parseStep, boardFrame } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
for (const id of ["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS"].flatMap((t) => f.byType.get(t) || [])) {
  const e = f.entities.get(id)!;
  if (e.args[0] !== process.argv[3]) continue;
  console.log(id, JSON.stringify(boardFrame(f, id)));
}
import { readBoards } from "../src/index";
for (const id of f.byType.get("MANIFOLD_SOLID_BREP") || []) {
  if (f.entities.get(id)!.args[0] !== process.argv[3]) continue;
  const r = readBoards(f, [id]);
  const b = r.boards[0];
  console.log(b ? `board: thickness ${b.thickness}, z ${b.part.zmin}..${b.part.zmax}, bbox ${b.part.bbox.map((v) => v.toFixed(1))}` : `other: ${r.other[0].reason}`);
}
