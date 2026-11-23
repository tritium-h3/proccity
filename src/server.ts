import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { corsOrigins, PORTS, TLS_PATHS } from './config.js';
import { startHttpRedirect } from './server/redirect.js';
import { loadTls } from './server/tls.js';
import { createWebHandler } from './server/web.js';

// Express is the only thing facing the internet: the built frontend from dist/ plus /api.
// After the 2026-11-22 cryptominer incident in pages, `vite dev` (source files, /@fs/, the
// transform pipeline) no longer is; `vite build --watch` keeps dist/ current. The API is a
// placeholder for now: generation runs in the browser.

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : PORTS.web;

app.use(cors({ origin: corsOrigins(), credentials: true }));
app.use(express.json());

// API requests only: static asset hits from every page load would bury these.
app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl.split('?')[0]}`);
  next();
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(createWebHandler(path.resolve('dist')));

// Express recognises error handlers by their arity of four. Never echo a 5xx message: it
// can name server paths.
app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

// A bad cert falls back to plain HTTP rather than throwing: under systemd's Restart=always a
// startup throw is a silent restart loop.
const tlsOptions = loadTls(TLS_PATHS);
const server: http.Server | https.Server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
const scheme = tlsOptions ? 'https' : 'http';

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[host] server error (${error.code ?? 'unknown'}):`, error.message);
});
try {
  startHttpRedirect(PORTS.httpRedirect, PORT);
} catch (error) {
  console.error('[host] could not start http redirect:', error);
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`proccity serving on ${scheme}://0.0.0.0:${PORT}`);
});
