// Owns the renderer, camera, lights and controls. React mounts it into a
// container element and swaps cities in; everything Three.js lives here.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { City } from '../city/generate.js';
import { createCityMeshes, disposeGroup } from './cityMeshes.js';

export type Backend = 'WebGPU' | 'WebGL 2';

export interface CityScene {
  /** resolves once the GPU backend is ready */
  ready: Promise<Backend>;
  setCity(city: City): void;
  dispose(): void;
}

const SKY = 0xb9c8d6;

export function createCityScene(container: HTMLElement): CityScene {
  // WebGPURenderer uses WebGPU where available and falls back to WebGL 2.
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r186
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 600, 1600);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
  camera.position.set(420, 320, 420);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // stay above the ground
  controls.minDistance = 30;
  controls.maxDistance = 1800;

  scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x4a4238, 1.2));

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  let cityGroup: THREE.Group | null = null;

  function setCity(city: City) {
    if (cityGroup) {
      scene.remove(cityGroup);
      disposeGroup(cityGroup);
    }
    cityGroup = createCityMeshes(city);
    scene.add(cityGroup);

    // Fit the sun's shadow camera to the city so the shadow map isn't wasted.
    const half = Math.max(city.width, city.depth) / 2;
    // A low sun (~35°) off to the camera's left, so shadows fall across the
    // default view instead of hiding behind the buildings that cast them.
    sun.position.set(-half * 0.9, half * 0.9, half * 1.0);
    const cam = sun.shadow.camera;
    cam.left = -half * 1.2;
    cam.right = half * 1.2;
    cam.top = half * 1.2;
    cam.bottom = -half * 1.2;
    cam.near = 1;
    cam.far = half * 5;
    cam.updateProjectionMatrix();
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
      controls.update();
      renderer.render(scene, camera);
    });
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  });

  return {
    ready,
    setCity,
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      if (cityGroup) disposeGroup(cityGroup);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
