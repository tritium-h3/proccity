import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'node:http'
import { HOSTNAMES, PORTS } from './src/config.js'

// HTTP→HTTPS redirect server (map external port 80 here if ever needed).
function httpRedirectPlugin() {
  return {
    name: 'http-redirect',
    configureServer() {
      http.createServer((req, res) => {
        const host = req.headers.host?.replace(/:\d+$/, '') ?? 'samarkand.hopto.org'
        res.writeHead(301, { Location: `https://${host}:${PORTS.vite}${req.url}` })
        res.end()
      }).listen(PORTS.httpRedirect, '0.0.0.0')
    },
  }
}

export default defineConfig({
  plugins: [react(), httpRedirectPlugin()],
  resolve: {
    // Addons (OrbitControls etc.) import bare 'three'; point that at the WebGPU
    // build we use so the page bundles one copy of Three, not two.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    host: '0.0.0.0',
    port: PORTS.vite,
    strictPort: true,
    https: {
      cert: '/etc/ssl/certs/samarkand_hopto_org.pem',
      key: '/home/tritium/myserver.key',
    },
    allowedHosts: HOSTNAMES.filter(host => host !== 'localhost') as string[],
    proxy: {
      '/api': { target: `http://localhost:${PORTS.api}` },
    },
  },
})
