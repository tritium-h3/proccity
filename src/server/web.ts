// Serves the built frontend. Ported from pages (src/platform/server/web.ts) after the
// 2026-11-22 cryptominer incident there: the internet sees dist/ and /api, never vite dev.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Vite fingerprints everything under /assets/, so those can be cached forever.
 *  Everything else (index.html above all) must be revalidated, or a refresh
 *  after a rebuild would keep pointing at the old asset hashes. */
export function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? IMMUTABLE : 'no-cache';
}

const BUILDING_PAGE = '<!doctype html><title>Building…</title><p>Building… refresh in a moment.</p>';

/** Serves the built frontend from `distDir`, and nothing outside it. Mount it
 *  after the /api slices. */
export function createWebHandler(distDir: string): Router {
  const router = express.Router();
  const indexPath = path.join(distDir, 'index.html');

  router.use(express.static(distDir, {
    index: 'index.html',
    dotfiles: 'ignore',
    setHeaders: (res, filePath) => {
      const urlPath = '/' + path.relative(distDir, filePath).split(path.sep).join('/');
      res.setHeader('Cache-Control', cacheControlFor(urlPath));
    },
  }));

  // SPA fallback for client-side routes (none yet; cheap to keep, and it matches pages).
  // Anything that looks like a file (has an extension) is left to 404: answering a
  // missing /assets/old-hash.js with HTML would surface as a confusing MIME error.
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    if (/\.[^/]+$/.test(req.path)) return next();

    // Checked per request so the site recovers as soon as the first
    // `vite build --watch` output lands.
    const building = () => {
      res.status(503).type('html').set('Cache-Control', 'no-store').send(BUILDING_PAGE);
    };
    if (!fs.existsSync(indexPath)) return building();
    // A rebuild can empty dist/ between the check above and the open. Passing
    // that error on would reach server.ts's error handler, which would echo
    // err.message (the absolute path) to the public.
    res.set('Cache-Control', 'no-cache').sendFile(indexPath, error => {
      if (!error) return;
      if (res.headersSent) return res.end();
      building();
    });
  });

  return router;
}
