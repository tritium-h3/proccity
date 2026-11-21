import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import { corsOrigins, PORTS } from './config.js';

// The backend is a placeholder for now: generation runs in the browser. It
// exists so saved cities / shared state have an obvious home later.

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : PORTS.api;

app.use(cors({ origin: corsOrigins(), credentials: true }));
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Express recognises error handlers by their arity of four.
app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

const server = http.createServer(app);
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[host] http server error (${error.code ?? 'unknown'}):`, error.message);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`proccity backend on http://0.0.0.0:${PORT}`);
});
