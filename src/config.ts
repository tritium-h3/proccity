/** Hostnames this project is reached by. Adding one here updates both the
 *  backend CORS allowlist and Vite's allowedHosts. */
export const HOSTNAMES = ['localhost', 'samarkand.hopto.org', 'torment-nexus.local'] as const;

/** Ports this project owns (block 5280–5282). Sibling projects' ports are
 *  recorded in pages' src/platform/config.ts (NEIGHBOUR_PORTS). */
export const PORTS = {
  httpRedirect: 5280,
  vite: 5281,
  api: 5282,
} as const;

/** Origins accepted by the backend's CORS middleware. */
export function corsOrigins(): string[] {
  const origins: string[] = [];
  for (const host of HOSTNAMES) {
    for (const scheme of ['http', 'https']) {
      origins.push(`${scheme}://${host}`);
      origins.push(`${scheme}://${host}:${PORTS.vite}`);
      origins.push(`${scheme}://${host}:${PORTS.api}`);
    }
  }
  return origins;
}
