// Usage: bun tools/slowest.ts <file.step> — time per solid
import { parseStep, readBoards } from "../src/index";
const f = parseStep(await Bun.file(process.argv[2]).text());
const ids = ["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS"].flatMap((t) => f.byType.get(t) || []);
const times = ids.map((id) => { const t = performance.now(); const r = readBoards(f, [id]); return { id, ms: performance.now() - t, name: (r.boards[0]?.name ?? r.other[0]?.name ?? "").slice(0, 30), faces: ((f.entities.get((f.entities.get(id)!.args[1] as any).id)!.args[1] as any[]) ?? []).length, board: r.boards.length > 0 }; });
times.sort((a, b) => b.ms - a.ms);
console.log(`total ${times.reduce((s, t) => s + t.ms, 0).toFixed(0)} ms`);
for (const t of times.slice(0, 10)) console.log(`${t.ms.toFixed(0).padStart(6)} ms  ${t.faces} faces  ${t.name}`);
