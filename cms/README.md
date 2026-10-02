# Owner News — isolated editorial CMS

Task 1 scaffold using Payload 3.90.2, Next.js 16.3.8 and React 19.3.0.
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
| `PORTAL_PUBLIC_URL` | HTTP(S) origin only, without credentials, path, query or fragment |
| `PORTAL_INTERNAL_URL` | HTTP(S) base URL, without credentials, query or fragment |
| `PAYLOAD_TO_PORTAL_SECRET` | At least 32 characters, distinct from the reverse secret |
| `PORTAL_TO_PAYLOAD_SECRET` | At least 32 characters, distinct from the reverse secret |
| `CMS_UPLOAD_DIR` | Absolute private storage path for subsequent media tasks |

Generate operational service secrets from at least 32 random bytes outside Git.
Validation errors name the variable and omit its value and parser cause.
Storage paths follow the host OS; the deployment target remains Linux/VPS.

`npm --prefix cms run dev` and `start` use port 3001. Native routes are
`/editorial/admin` and `/editorial/api/*`, with no Next `basePath` and no mounted
GraphQL handler. Native authentication and first-user registration are disabled;
`portal-editors` denies admin/create/read/update/delete until Task 3.
`/editorial/ready` initializes Payload and performs a bounded identity-collection
query, returning only `{ "status": "ready" }` (200) or
`{ "status": "unavailable" }` (503). A real readiness check requires an authorized,
migrated database and belongs to the later full-stack acceptance task.

PostgreSQL uses UUIDs, no schema push and no automatic database creation. The
explicit migration registry is wired as Payload `prodMigrations`; future entries
can execute during production initialization. Review migrations before authorizing
runtime operation. No jobs auto-run in this scaffold; the separate `jobs:run`
command is reserved for the later queue implementation.

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
