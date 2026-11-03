# qstep plan

**Goal:** replace OpenCascade (occt-import-js) in ManualNest's STEP import with a TypeScript reader that is fast enough to run in the browser, and share it with Baluster Studio.

**Why:** OpenCascade takes 30–40 s to read and mesh a 136-body Onshape cabinet file (18 MB, 400k triangles). ManualNest's import does that work twice: once in the browser for the import dialog, once on the server. qstep parses the same file in about 0.6 s.

## Steps

| Step | What | Status |
|---|---|---|
| S1 | Baluster Studio's reader copied in as is (parse, B-rep, NURBS, clip; commit cb50604) | done |
| S2 | Assembly structure: product tree, instance placements, solids per product, colours (`readAssembly`, `solidInstances`) | done: same 136 instances as OpenCascade on the cabinet file |
| S3 | Body geometry in any orientation: read one solid's faces in its own coordinates, find the board's thickness axis (the largest pair of opposite parallel planes), then run Baluster's 2.5D analysis (outline, holes, pockets, top and bottom faces) in that board frame. Bodies that are not boards (hardware) are flagged instead of rejected. | done: on the cabinet file 1.5 s against OpenCascade's 40 s for the whole import. 63 of 98 boards agree exactly with the current import; where they differ, qstep is right in every case checked: exact curves instead of mesh polygons, rounded-over edges kept in the width, and two parts the current import lays on the wrong side. |
| S4 | Display meshes for every body, with the surfaces hardware uses: sphere, torus, surface of revolution, extrusion, offset surface. Unknown faces are skipped with a warning, not fatal. | done: every curved face is meshed in its own (u, v) space (`tess.ts`), in any orientation. `readMeshes` gives one mesh per placed solid, in OpenCascade's order and names. Cabinet file: 136 bodies in 5–6 s (OpenCascade 40 s); 125 agree with OpenCascade within 1% volume and 2% area, every board among them. The rest are hardware with threads (ball screw, nuts, bolts, a barbed fitting), where some helical faces still come out slightly wrong. |
| S5 | ManualNest server import through qstep: the same `Part` and `StepPartMetadata` (face frames, outline, thickness, colour, pose) and mesh asset with the tree. Checked against the OpenCascade path on the stored files. OpenCascade stays as the fallback when qstep refuses a file. | |
| S6 | ManualNest import dialog reads the file with qstep in a web worker, with no OpenCascade in the browser. The server reuses the result, so the file is read once. | |
| S7 | Baluster Studio switches to qstep (needs Ludvig's OK) | |

## Checks

- `bun test`: hand-written fixtures. Private fixtures (`test/fixtures/private/`, git-ignored) are skipped when missing.
- `tools/occt-compare.ts`: per-instance bounding boxes against OpenCascade's meshes on a real file.
