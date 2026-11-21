# proccity — procedural 3D cities in the browser

A standalone project (own repo, own service, own ports) linked from the `pages` gallery.
Conventions follow `~/.claude/CLAUDE.md`; this file covers what's specific here.

## Architecture

- **`src/city/`: generation, pure TypeScript, no Three.js.** `generateCity(options)`
  returns plain data (`City` → `blocks`, `buildings`) in metres, centred on the origin,
  Y up. It takes a seed so tests can reproduce output. Tested with Vitest
  (`generate.test.ts`).
- **`src/scene/`: rendering.** `cityScene.ts` owns renderer, camera, lights, controls and
  the animation loop; `cityMeshes.ts` turns `City` data into meshes. Buildings are one
  `InstancedMesh` (one draw call for the whole skyline), each instance a scaled unit
  cube with its base at y=0.
- **`src/App.tsx`: React only for the UI around the canvas.** It creates the scene once
  in an effect (StrictMode-safe: `dispose()` on cleanup) and pushes new cities into it.
- **`src/server.ts`: placeholder Express backend** (`/api/health` only). Generation is
  client-side; the backend exists so saved/shared cities have a home later.
- `src/config.ts`: hostnames and ports, shared by Vite and the server.

## Three.js notes

- **Import from `three/webgpu`, not `three`.** `WebGPURenderer` uses WebGPU where available
  and falls back to WebGL 2 by itself. Vite aliases bare `three` to `three/webgpu` so
  addons (`three/addons/...`) share the same copy. The UI shows which backend is active.
- Three changes API between releases. Check the installed source in `node_modules/three`
  before relying on memory (e.g. `PCFSoftShadowMap` was removed in r186).
- **A blank canvas with "WebGPU" in the panel means the GPU device was lost.** Seen
  2026-11-20 on the owner's laptop (Chrome/Linux, hybrid NVIDIA 3050 Ti, experimental
  WebGPU flags on): `VK_ERROR_OUT_OF_DEVICE_MEMORY` even for a raw WebGPU clear with no
  Three.js. That's an environment problem, not ours. The owner turned the flags off
  rather than have us add a device-loss → WebGL fallback. Don't re-propose it unprompted.
- Headless Chrome: default flags give WebGL 2 only. `--enable-unsafe-webgpu
  --enable-features=Vulkan` gives a SwiftShader WebGPU adapter whose device is lost
  immediately, even for raw WebGPU, so it **can't test WebGPU rendering**.
  `--virtual-time-budget` stalls async GPU init, so drive Chrome in real time over CDP
  (`--remote-debugging-port`) when you need console output from GPU code.

## Dev

**Git:** agents manage the repo. Feature work goes on a branch with a commit per task;
`main` takes merged work. Pushing to GitHub needs the owner's OK.

Runs as the systemd user service **`proccity`** (Vite + API via `concurrently`):
- Vite (HTTPS) **5281**, API **5282**, HTTP→HTTPS redirect **5280**.
- `npm run dev:restart`, `systemctl --user status proccity`, `journalctl --user -u proccity -f`
- `npm test`, `npm run typecheck` (TypeScript 7), `npm run lint` (**oxlint**:
  typescript-eslint doesn't support TS 7 yet; oxlint is silent when clean),
  `npm run build` (the ~1 MB chunk warning is Three.js and expected).

**Screenshot check:** headless Chrome's capture is 87px taller than the page viewport, so
a dark strip along the bottom is an artefact, not a layout bug. Pass a window height
87px larger than the viewport you want:
`google-chrome --headless=new --no-sandbox --ignore-certificate-errors --hide-scrollbars
--enable-unsafe-swiftshader --window-size=1200,907 --virtual-time-budget=12000
--screenshot=<out>.png https://localhost:5281/`
