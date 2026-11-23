/** Hostnames this project is reached by. Adding one here updates the backend CORS
 *  allowlist. */
export const HOSTNAMES = ['localhost', 'samarkand.hopto.org', 'torment-nexus.local'] as const;

/** Ports this project owns (block 5280–5282). Express is the only listener: HTTPS app + API
 *  on `web`, a bare HTTP->HTTPS redirect on `httpRedirect`. 5282 (the old internal API port
 *  behind the Vite proxy) was retired when proccity stopped exposing `vite dev`, after the
 *  2026-11-22 cryptominer incident in pages; the block stays reserved. Sibling projects'
 *  ports are recorded in pages' src/platform/config.ts (NEIGHBOUR_PORTS). */
export const PORTS = {
  httpRedirect: 5280,
  web: 5281,
} as const;

/** TLS material for samarkand.hopto.org, shared with sibling projects that read the same
 *  paths. Swapping certs means replacing these files and restarting the service. */
export const TLS_PATHS = {
  cert: '/etc/ssl/certs/samarkand_hopto_org.pem',
  key: '/home/tritium/myserver.key',
} as const;

/** Origins accepted by the backend's CORS middleware. */
export function corsOrigins(): string[] {
  const origins: string[] = [];
  for (const host of HOSTNAMES) {
    for (const scheme of ['http', 'https']) {
      origins.push(`${scheme}://${host}`);
      origins.push(`${scheme}://${host}:${PORTS.web}`);
    }
  }
  return origins;
}
