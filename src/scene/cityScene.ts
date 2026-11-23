// Owns the renderer, camera, lights and controls. React mounts it into a
// container and pushes ViewStates in; everything Three.js lives here.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Point2 } from '../doc/types.js';
import { buildView, groundHeightAt, outline, type BuiltView, type ViewState } from './view.js';

export type Backend = 'WebGPU' | 'WebGL 2';
export type { ViewState } from './view.js';

export interface PickHit { nodeId: string; point: Point2 }

export interface CityScene {
  /** resolves once the GPU backend is ready */
  ready: Promise<Backend>;
  setView(v: ViewState): void;
  onPick(fn: (hit: PickHit | null) => void): void;
  dispose(): void;
}

const SKY = 0xb9c8d6;
const SELECT = 0xe8925f;

export function createCityScene(container: HTMLElement): CityScene {
  // WebGPURenderer uses WebGPU where available and falls back to WebGL 2.
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  // 1.5, not 2: on a high-DPI screen 2 shades ~78 % more pixels for a barely visible gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r186
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 2500, 7000);

  const camera = new THREE.PerspectiveCamera(45, 1, 2, 20000);
  camera.position.set(1400, 1100, 1400);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // stay above the ground
  controls.minDistance = 20;
  controls.maxDistance = 9000;

  scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x4a4238, 1.2));

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  // The shadow map only changes when the city does (the sun and its shadow box are fixed to
  // the site), so it isn't redrawn every frame: re-rendering the ground into 4096² each frame
  // was a large share of the cost of orbiting. After a change it's redrawn for a second, since
  // new materials can compile asynchronously and miss a single frame.
  sun.shadow.autoUpdate = false;
  let shadowUntil = 0;
  const refreshShadows = () => { shadowUntil = performance.now() + 1000; };
  scene.add(sun, sun.target);

  let built: BuiltView | null = null;
  let selection: THREE.Group | null = null;
  let hover: THREE.Group | null = null;
  let view: ViewState | null = null;
  let siteSize = 0;

  const clearOutline = (g: THREE.Group | null) => {
    if (!g) return;
    scene.remove(g);
    g.traverse(o => { if (o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  };

  function fitToSite(size: number, centreHeight: number) {
    if (size === siteSize) return;
    siteSize = size;
    const half = size / 2;
    // A low sun (~35°) off to the camera's left, so shadows fall across the view.
    sun.position.set(-half * 0.9, half * 0.9, half * 1.0);
    const cam = sun.shadow.camera;
    cam.left = -half * 1.2; cam.right = half * 1.2; cam.top = half * 1.2; cam.bottom = -half * 1.2;
    cam.near = 1; cam.far = half * 5;
    cam.updateProjectionMatrix();
    (scene.fog as THREE.Fog).near = size * 1.25;
    (scene.fog as THREE.Fog).far = size * 3.5;
    // Frame the whole site from the default three-quarter view.
    camera.position.set(size * 1.05, centreHeight + size * 0.85, size * 1.05);
    controls.target.set(0, centreHeight, 0);
  }

  function setView(v: ViewState) {
    view = v;
    if (built) { scene.remove(built.group); built.dispose(); }
    built = buildView(v);
    scene.add(built.group);
    refreshShadows();
    const b = v.tree.geometry.footprint[0]?.[0];
    if (b) fitToSite(Math.max(...b.map(p => Math.abs(p[0]))) * 2, groundHeightAt(v.tree, 0, 0));
    clearOutline(selection);
    selection = v.selectedId ? outline(v.tree, v.selectedId, SELECT, 1) : null;
    if (selection) scene.add(selection);
  }

  // Picking: a click without a drag raycasts the current stage's meshes.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pickFn: ((hit: PickHit | null) => void) | null = null;
  let down: { x: number; y: number } | null = null;

  function hitAt(e: PointerEvent): PickHit | null {
    if (!built) return null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(built.pickables.map(p => p.mesh), false);
    // Prefer the current stage's regions over the site ground beneath them.
    const ordered = [...hits.filter(h => built!.pickables.findIndex(p => p.mesh === h.object) > 0), ...hits];
    const h = ordered[0];
    if (!h || h.faceIndex == null) return null;
    const p = built.pickables.find(pk => pk.mesh === h.object)!;
    const point: Point2 = [h.point.x, h.point.z];
    const nodeId = p.nodeIdAt ? p.nodeIdAt(point) : p.nodeIdForFace?.(h.faceIndex) ?? null;
    return nodeId ? { nodeId, point } : null;
  }

  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
    down = null;
    pickFn?.(hitAt(e));
  };
  let hoverQueued: PointerEvent | null = null;
  const onMove = (e: PointerEvent) => { hoverQueued = e; };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointermove', onMove);

  function updateHover() {
    if (!hoverQueued || !view) return;
    const e = hoverQueued;
    hoverQueued = null;
    const hit = hitAt(e);
    clearOutline(hover);
    hover = hit && hit.nodeId !== view.selectedId ? outline(view.tree, hit.nodeId, SELECT, 0.4) : null;
    if (hover) scene.add(hover);
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let disposed = false;
  const ready = renderer.init().then(() => {
    if (disposed) throw new Error('disposed');
    renderer.setAnimationLoop(() => {
      updateHover(); // at most one hover raycast per frame
      controls.update();
      if (performance.now() < shadowUntil) sun.shadow.needsUpdate = true;
      renderer.render(scene, camera);
    });
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  });

  return {
    ready,
    setView,
    onPick(fn) { pickFn = fn; },
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.setAnimationLoop(null);
      controls.dispose();
      built?.dispose();
      clearOutline(selection);
      clearOutline(hover);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
