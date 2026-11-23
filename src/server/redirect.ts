// Ported from pages (src/platform/server/redirect.ts), with one difference: pages drops the
// port because the router maps external 443 to it; nothing maps to proccity, so its public
// URL keeps the HTTPS port.
import http from 'node:http';

const DEFAULT_HOST = 'samarkand.hopto.org';

/** Where a plain-HTTP request should be sent: the same host and path on the HTTPS port. */
export function redirectLocation(hostHeader: string | undefined, url: string | undefined, httpsPort: number): string {
  const host = hostHeader?.replace(/:\d+$/, '') || DEFAULT_HOST;
  return `https://${host}:${httpsPort}${url || '/'}`;
}

/** Bare HTTP->HTTPS 301 server. A bind failure is logged, never thrown: the main server
 *  must keep serving without it. */
export function startHttpRedirect(port: number, httpsPort: number): http.Server {
  const server = http.createServer((req, res) => {
    res.writeHead(301, { Location: redirectLocation(req.headers.host, req.url, httpsPort) });
    res.end();
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[host] http redirect on ${port} failed (${error.code ?? 'unknown'}):`, error.message);
  });
  server.listen(port, '0.0.0.0');
  return server;
}
