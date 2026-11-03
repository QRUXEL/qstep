// Usage: bun tools/boards.ts <file.step> — the boards qstep finds, and what it skips.
import { parseStep, readBoards } from "../src/index";
const t0 = performance.now();
const f = parseStep(await Bun.file(process.argv[2]).text());
const t1 = performance.now();
const { boards, other, warnings } = readBoards(f);
const t2 = performance.now();
console.log(`parse ${(t1 - t0).toFixed(0)} ms, boards ${(t2 - t1).toFixed(0)} ms: ${boards.length} boards, ${other.length} other solids`);
const byThickness = new Map<string, string[]>();
for (const b of boards) {
  const k = b.thickness.toFixed(2);
  byThickness.set(k, [...(byThickness.get(k) ?? []), `${b.name} ${(b.part.bbox[2] - b.part.bbox[0]).toFixed(1)}×${(b.part.bbox[3] - b.part.bbox[1]).toFixed(1)}${b.part.pockets.length ? ` (${b.part.pockets.length} pockets)` : ""}${b.part.holes.length ? ` (${b.part.holes.length} holes)` : ""}`]);
}
for (const [k, list] of [...byThickness].sort((a, b) => +a[0] - +b[0])) console.log(`  ${k} mm × ${list.length}: ${list.slice(0, 6).join(", ")}${list.length > 6 ? ", …" : ""}`);
const reasons = new Map<string, string[]>();
for (const o of other) { const k = o.reason.replace(/#\d+/g, "#").slice(0, 90); reasons.set(k, [...(reasons.get(k) ?? []), o.name]); }
for (const [k, names] of reasons) console.log(`  other (${names.length}): ${k} — ${names.slice(0, 4).join(", ")}`);
if (warnings.length) console.log(`warnings: ${warnings.slice(0, 5).join(" | ")}`);
