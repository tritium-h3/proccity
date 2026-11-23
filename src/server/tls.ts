// Ported from pages (src/platform/server/tls.ts).
import fs from 'node:fs';
import tls from 'node:tls';

export interface TlsOptions {
  cert: Buffer;
  key: Buffer;
}

/** Reads and validates the cert/key pair. Any failure (missing file, garbage,
 *  a key that doesn't match the cert) returns null so the caller can fall back
 *  to plain HTTP: a throw here would stop listen() and, under systemd's
 *  Restart=always, become a silent restart loop. */
export function loadTls(paths: { cert: string; key: string }): TlsOptions | null {
  try {
    const cert = fs.readFileSync(paths.cert);
    const key = fs.readFileSync(paths.key);
    tls.createSecureContext({ cert, key });
    return { cert, key };
  } catch (error) {
    console.error(`[host] TLS unavailable (${(error as Error).message}); serving plain HTTP`);
    return null;
  }
}
