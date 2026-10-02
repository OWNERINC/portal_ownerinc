# Owner News — isolated editorial CMS

Isolated service using Payload 3.90.2, Next.js 16.3.8 and React 19.3.0,
with Portal-backed revocable authentication (Task 3).
This service requires **Node 24** (`>=24 <25`), an approved architecture exception
to the repository's Node 18 compatibility rule for shared API/cron code.

## Local checks

From the repository root:

```sh
npm --prefix cms ci
npm --prefix cms run test:unit
npm --prefix cms run typecheck
npm --prefix cms run build
npm run verify
git diff --check
```

`next build` selects an explicit synthetic environment through `CMS_BUILD_ONLY`
and Next's `phase-production-build`. It never falls back to real connection
strings. Admin and readiness are dynamic; build only compiles configuration and
routes. No database, uploads or running Portal is needed. `next start` rejects
either build signal. Do not set these signals in runtime environments.

Type and import-map generation also need configuration, but do not connect to a
database. For offline generation in a **temporary shell environment**:

```sh
CMS_BUILD_ONLY=true NEXT_PHASE=phase-production-build npm --prefix cms run generate:types
CMS_BUILD_ONLY=true NEXT_PHASE=phase-production-build npm --prefix cms run generate:importmap
```

On PowerShell, use `$env:CMS_BUILD_ONLY = 'true'` and
`$env:NEXT_PHASE = 'phase-production-build'` in a temporary process before those
commands. Close that process after generation. Commit generated
`src/payload-types.ts` and `src/app/(payload)/editorial/admin/importMap.js`.
`next-env.d.ts` is Next's generated TypeScript support file. The migration
registry is intentionally empty; no schema migration is generated or executed
in this task.

## Runtime configuration

Supply these privately to the service (Payload CLI also loads its local `.env`):

| Variable | Requirement |
|---|---|
| `CMS_DATABASE_URL` | PostgreSQL URI with host and database; TLS query options allowed |
| `PAYLOAD_SECRET` | At least 32 characters |
| `PORTAL_PUBLIC_URL` | HTTPS origin; HTTP loopback only with `NODE_ENV=development`; no credentials, path, query or fragment |
| `PORTAL_INTERNAL_URL` | HTTP(S) base URL, without credentials, query or fragment |
| `PAYLOAD_TO_PORTAL_SECRET` | At least 32 characters, distinct from the reverse secret |
| `PORTAL_TO_PAYLOAD_SECRET` | At least 32 characters, distinct from the reverse secret |
| `CMS_UPLOAD_DIR` | Absolute private storage path for subsequent media tasks |

Generate operational service secrets from at least 32 random bytes outside Git.
Validation errors name the variable and omit its value and parser cause.
Storage paths follow the host OS; the deployment target remains Linux/VPS.

`npm --prefix cms run dev` and `start` use port 3001. Native routes are
`/editorial/admin` and `/editorial/api/*`, with no Next `basePath` and no mounted
GraphQL handler. Local passwords, first-user registration, API keys and Payload
JWT refresh are disabled. `portal-editors` is a private identity projection with
a unique `portalUid`; only the verified Portal strategy can create it. Its read
access is scoped to the current editor, and public create/update/delete are denied.
`/editorial/ready` initializes Payload and performs a bounded identity-collection
query, returning only `{ "status": "ready" }` (200) or
`{ "status": "unavailable" }` (503). A real readiness check requires an authorized,
migrated database and belongs to the later full-stack acceptance task.

PostgreSQL uses UUIDs, no schema push and no automatic database creation. The
explicit migration registry is wired as Payload `prodMigrations`; future entries
can execute during production initialization. Review migrations before authorizing
runtime operation. No jobs auto-run in this scaffold; the separate `jobs:run`
command is reserved for the later queue implementation.

## Portal authentication boundary

The API needs `PORTAL_PUBLIC_URL` and `PAYLOAD_TO_PORTAL_SECRET` only when its
editorial routes are called. Existing Portal startup/routes do not require CMS
configuration. The two service secrets must be distinct. Use canonical origin
configuration in both services and generate secrets privately from 32 random bytes.

The native custom strategy reads only `__Host-ownerinc-editorial` (or
`ownerinc-editorial-dev` for development HTTP loopback). Every request resolves it
through `POST /api/internal/editorial/session/resolve`, with a dedicated Bearer
service secret, 5-second timeout, `redirect: 'error'` and `cache: 'no-store'`.
No authorization cache is shared between requests. The Portal checks the active
hash, Firebase revocation, UID equality, current account and `manageKnowledge`.
Runtime `portalActor`/`portalExpiresAt` are never saved as authority.

Payload 3.90.2 catches custom-strategy exceptions. The strategy therefore returns
controlled failure headers with `user: null`; the native REST wrapper converts
them to 401/403/503 and removes the internal marker headers. Access checks also
surface dependency failure rather than redirecting the admin as if revoked.
All native REST responses use `no-store`. `src/proxy.ts` guards mutations across
the entire `/editorial/:path*` namespace before Next dispatch, including native
layout actions such as the language-cookie action and form POSTs without a
`next-action` header. It requires the exact configured Origin and rejects
`Sec-Fetch-Site: cross-site`; missing/invalid configuration fails closed. The
existing REST and custom server-function checks remain in place. The proxy only
enforces this request boundary; it does not cache authentication or add CSP.

The Portal mounts its private editorial router before the public 300/15-minute
IP limiter. After service authentication, dedicated **per-process aggregate**
one-minute buckets allow 3000 resolves, 300 revokes, 600 actor checks and 120
authority reads. These fixed-key buckets never use forwarded browser IPs or
body-supplied identity. Invalid service credentials have a separate 60/minute
rejection budget. Exceeding a lane returns 429 before JSON parsing/DB/Firebase
work; resolve exhaustion leaves logout/job/authority capacity available. The
client retains its controlled 503 mapping for upstream throttling. Public limits
and Bearer per-UID write limits retain their previous behavior. Multi-process
capacity and real load tuning belong to later operational acceptance.

Later private POST endpoints under `/editorial/api/portal-news/*` must add an
explicit, service-authenticated request-boundary path when that interface is
implemented; the current proxy deliberately has no Origin exemption for a future
namespace. Future Portal internal operations need their own bounded quota before
their parser/handler. Task 13 must retain this Origin guard when adding CSP.

Native login/password/first-user pages forward to `/editorial-entry.html`.
The GET logout page only forwards to `/editorial-entry.html?logout=1`; it has no
revocation side effect. Native POST logout uses `afterLogout` to revoke the hash
and clears the cookie only after confirmed success. A failed revoke returns 503.

**Downstream dependency — Task 9:** the static entry/exit page, Portal logout
integration, retry UI and cross-tab Firebase/editorial UID mismatch observer are
not delivered here. The entry page must issue `POST /api/cms/session`; the exit
flow must confirm `DELETE /api/cms/session` before claiming logout. The native
login/exit redirects are not a complete browser journey until Task 9 exists.

The generated identity fields still require a reviewed Payload schema migration
in the later schema task; none was generated or executed here. Local auth checks
run real Express/Payload policies and native Fetch handlers with Firebase, pg,
internal HTTP and DB-adapter doubles. They are **not real authentication acceptance**.
PostgreSQL uniqueness/races, Firebase HTTP, Nginx and browser integration remain pending.

## Dependency review (2026-10-02)

All exact Task 1 pins were available on the public npm registry and their peer
and Node ranges were compatible. No package versions were substituted.
`npm audit` reported 14 findings: 2 low, 11 moderate, 1 high. The high finding is
transitive `undici@7.29.0`, pinned by Payload; advisories include
GHSA-rfgv-xxqx-mfg5 and GHSA-w293-vg96-wgc3 (fixed upstream in 7.29.1).
The remaining roots include DOMPurify (GHSA-p98j-92pf-mc4p) and the legacy
Drizzle/esbuild toolchain (GHSA-67mh-4wv8-2f99). The npm-proposed Payload downgrade
conflicts with the approved pins. Version/override decisions require follow-up;
this scaffold does not claim a clean dependency audit or production acceptance.
