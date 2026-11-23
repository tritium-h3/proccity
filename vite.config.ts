import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build-only. proccity doesn't run `vite dev` for the public site: Express serves this
// build's dist/ (src/server/web.ts), and `vite build --watch` rebuilds it on save.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Addons (OrbitControls etc.) import bare 'three'; point that at the WebGPU
    // build we use so the page bundles one copy of Three, not two.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
})
