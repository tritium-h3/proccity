# proccity

Procedural cities, rendered in 3D in the browser with Three.js (WebGPU, falling back to
WebGL 2).

Cities are generated in stages by a shape grammar: each stage divides the regions the
previous stage produced. Built so far: the foundation (city document, stage pipeline in a
Web Worker, local overrides, undo/redo, IndexedDB storage plus JSON download/open, the
editor) and the **terrain** stage. Terrain covers sea, river and ponds, level flats at
chosen elevations, and slopes and hills, on a height map shaped around the water. Districts
come next.

```bash
npm install
npm run dev        # builds on save; Express serves https://localhost:5281 (app + API)
npm test
```

In this environment it runs as the `proccity` systemd user service. See `CLAUDE.md`.
