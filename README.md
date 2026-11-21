# proccity

Procedural cities, rendered in 3D in the browser with Three.js (WebGPU, falling back to
WebGL 2).

Cities are generated in stages by a shape grammar: each stage divides the regions the
previous stage produced. The current state is the **foundation**: the city document,
stage pipeline (in a Web Worker), local overrides, undo/redo, browser storage
(IndexedDB, plus JSON download/open) and the editor. Two throwaway debug stages exercise it
until the real stages (terrain, districts, roads, …) are built.

```bash
npm install
npm run dev        # https://localhost:5281 (API on 5282)
npm test
```

In this environment it runs as the `proccity` systemd user service. See `CLAUDE.md`.
