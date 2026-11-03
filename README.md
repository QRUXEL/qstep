# qstep

A STEP (ISO 10303-21) reader for sheet-material parts, in TypeScript, without OpenCascade. Shared by ManualNest and Baluster Studio.

- `parseStep(text)` reads the file into entities (no geometry).
- `readModel(file)` reads the B-rep: planes, cylinders, cones and B-spline surfaces, bounded by lines, circles, ellipses and B-spline curves. Per solid it gives the outline and through-holes, the pocket levels, the top and bottom faces, and a triangle mesh.

It started as Baluster Studio's reader (`client/src/step`, Baluster Studio commit cb50604). That reader handles 2.5D parts lying flat. The plan is to grow it for ManualNest:

- the assembly tree, with each instance's placement and colour;
- boards in any orientation (each board's thickness axis found from its faces);
- display meshes for hardware bodies.

## Use

Vendored as a git subtree, the same way as qcam:

```sh
git subtree add --prefix vendor/qstep git@github.com:QRUXEL/qstep.git main --squash
```

## Tests

```sh
bun install
bun test
```

`test/fixtures/private/` is git-ignored. Tests that need files from it are skipped when the files are missing.
