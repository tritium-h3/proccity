# Production serving: design

**Status:** approved (owner: "replicate what was done in pages") · **Size:** small change

## Why

On 2026-11-22 an xmrig cryptominer was dropped through pages' internet-facing `vite dev`
server. The exploit was never pinned down. A dev server exposes source files, `/@fs/` and
a module-transform pipeline, far more than a public site needs. proccity had the same
exposure: `vite dev` on 5281, open in the firewall. pages fixed it by serving a build
from Express (`~/projects/pages/docs/superpowers/specs/2026-11-22-production-serving-design.md`).
This replicates that fix here.

## Goals

- The internet sees only Express: the `vite build` output in `dist/`, plus `/api`.
- Save, refresh, see the change, with a rebuild of a few seconds. There's no hot reload.
- The URLs stay the same: `https://samarkand.hopto.org:5281`, with HTTP on 5280
  redirecting to it.

## Non-goals

- Hot reload, a private dev server, or a VPN.
- Authentication. There is only `/api/health`.

## Anti-goals

- Serving anything outside `dist/`: source, `.env`, `data/`, `node_modules`.
- A startup crash loop. A missing `dist/` or a bad cert must not stop `listen()`.
- A tab stuck on a stale `index.html` after a rebuild.

## Design (as in pages, unless noted)

- `src/server.ts`:
  - HTTPS on `PORTS.web` (5281), using `TLS_PATHS`.
  - Plain HTTP with a loud log if the cert can't be loaded.
  - Mounts `/api`, then the web handler, then the error handler.
  - API-only request logging.
- `src/server/web.ts`:
  - `express.static(dist)`, with dotfiles ignored.
  - `/assets/*` is cached as immutable; everything else gets `no-cache`.
  - SPA fallback for GET/HEAD paths with no extension (excluding `/api`).
  - A 503 "Building…" page when `index.html` is missing, including the race where it
    vanishes mid-request, so the error handler can't echo the path.
- `src/server/tls.ts`: `loadTls` validates the pair and returns null on any failure.
- `src/server/redirect.ts`: a bare 301 server on 5280. **Differs from pages:** it
  redirects to `https://host:5281`, keeping the port. pages drops the port because the
  router maps external 443 to pages, and nothing maps to proccity.
- `config.ts`: `PORTS` becomes `{ httpRedirect: 5280, web: 5281 }`, so 5282 (the API
  behind the Vite proxy) is retired. `TLS_PATHS` moves here, and `corsOrigins` drops
  5282.
- `vite.config.ts` is build-only: the `three` alias stays; the server block, the proxy
  and the redirect plugin go.
- `package.json`: `dev` is `concurrently "vite build --watch" "tsx watch ./src/server.ts"`.
  The systemd unit is unchanged. `preview` goes.
- **Not ported:** pages' reload on `vite:preloadError`. pages lazy-loads page chunks
  that a rebuild deletes. proccity has no lazy chunks, and its generation worker is
  fetched when the page loads, so an open tab never needs a deleted file.

## Consequences

- The service now runs a production build, so the `import.meta.env.DEV` aids are off
  there: the worker's partition check and the terrain mesh timing log. The partition
  invariant is still covered by tests.
- The CLAUDE.md "stale dev server" note no longer applies. The source isn't served, so
  `curl .../src/file.ts` can't be used to compare versions; check `dist/` freshness instead.
- Port 5282 can be closed in the firewall. That's the owner's call, since it needs sudo.

## Tests

`web.ts`, `tls.ts` and `redirect.ts` are tested as pure modules, ported from pages: path
traversal, dotfiles, the 503 race, cache headers and the redirect target.
