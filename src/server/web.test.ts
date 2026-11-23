import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { cacheControlFor, createWebHandler } from './web.js';

const SECRET = 'TOP-SECRET-CONTENTS';
let root: string;
let dist: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-'));
  dist = path.join(root, 'dist');
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dist, 'assets', 'app-1.js'), 'console.log(1)');
  await fs.writeFile(path.join(root, 'secret.txt'), SECRET);
  await fs.writeFile(path.join(dist, '.env'), SECRET);

  const app = express();
  app.get('/api/ping', (_req, res) => { res.json({ pong: true }); });
  app.use(createWebHandler(dist));
  app.use((_req, res) => { res.status(404).json({ error: 'nf' }); });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.writeFile(path.join(dist, 'index.html'), '<html>APP</html>');
});

// Raw request so encoded traversal sequences reach the server unnormalised.
function rawGet(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('cacheControlFor', () => {
  it('caches hashed assets forever', () => {
    expect(cacheControlFor('/assets/index-abc123.js')).toBe('public, max-age=31536000, immutable');
  });

  it('never caches index.html or other files', () => {
    for (const p of ['/', '/index.html', '/sprites/manifest.json']) {
      expect(cacheControlFor(p)).toBe('no-cache');
    }
  });
});

describe('createWebHandler', () => {
  it('serves index.html at / with no-cache', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('APP');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('APP');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves hashed assets as immutable', async () => {
    const res = await fetch(`${base}/assets/app-1.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('404s a missing asset instead of returning index.html', async () => {
    const res = await fetch(`${base}/assets/missing-9.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('APP');
  });

  it('never serves dotfiles or files outside dist', async () => {
    for (const p of ['/.env', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/../secret.txt']) {
      const res = await rawGet(p);
      expect(res.body, p).not.toContain(SECRET);
    }
  });

  it('does not answer non-GET requests to client routes with index.html', async () => {
    const res = await fetch(`${base}/some/client/route`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('APP');
  });

  it('leaves API routes alone, known and unknown', async () => {
    expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({ pong: true });
    const nope = await fetch(`${base}/api/nope`);
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: 'nf' });
  });

  it('answers 503 Building, not an error naming the path, if index.html vanishes mid-request', async () => {
    // A directory makes existsSync pass and sendFile fail, which is the same
    // error path as `vite build --watch` emptying dist/ between the two calls.
    // Mount behind an error handler that echoes err.message, as server.ts does.
    await fs.rm(path.join(dist, 'index.html'));
    await fs.mkdir(path.join(dist, 'index.html'));
    try {
      const app = express();
      app.use(createWebHandler(dist));
      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(404).json({ error: err.message });
      });
      const s2 = app.listen(0);
      await new Promise<void>(resolve => s2.once('listening', () => resolve()));
      const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/some/client/route`);
      const body = await res.text();
      await new Promise<void>(resolve => s2.close(() => resolve()));
      expect(res.status).toBe(503);
      expect(body).toContain('Building');
      expect(body).not.toContain(dist);
    } finally {
      await fs.rm(path.join(dist, 'index.html'), { recursive: true, force: true });
    }
  });

  it('answers 503 Building while index.html does not exist yet', async () => {
    await fs.rm(path.join(dist, 'index.html'));
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Building');
  });
});
