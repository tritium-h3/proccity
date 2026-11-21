# proccity

Procedural cities, rendered in 3D in the browser with Three.js (WebGPU, falling back to
WebGL 2).

Current state: a proof of concept. A street grid of blocks with box buildings that rise
towards a downtown, orbit camera, sun with shadows, and a **New city** button.

```bash
npm install
npm run dev        # https://localhost:5281 (API on 5282)
npm test
```

In this environment it runs as the `proccity` systemd user service. See `CLAUDE.md`.
