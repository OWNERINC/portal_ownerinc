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
`next-env.d.ts` is Next's generated TypeScript support file. Task 4 generates the
initial CMS schema with the pinned CLI (including the Task 3 identity fields):

```sh
CMS_BUILD_ONLY=true NEXT_PHASE=phase-production-build npm --prefix cms run migrate:create -- owner_news_initial
node cms/scripts/format-migrations.mjs
```

`migrate:create` initializes the adapter with `disableDBConnect:true` and compares
local Drizzle snapshots. It writes SQL, a JSON snapshot and the migration index;
it does not apply SQL. Subsequent changes use a new migration name.
The formatter removes only CLI-generated SQL indentation/trailing whitespace for
`git diff --check`; it does not alter statements or schema snapshots. Application
with `npm --prefix cms run migrate` requires a separately authorized **CMS-only**
database and migration role supplied through private environment configuration.
No migration has been applied as part of Task 4.

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

PostgreSQL uses UUIDs, no schema push and no automatic database creation. Migrations
are CLI-only: **`prodMigrations` is intentionally not wired to the runtime adapter**,
because Payload 3.90.2 invokes it on production connection initialization (even for
an empty array). Runtime must use a restricted role; effective grants/connection
identity remain an integration gate. No jobs auto-run in this scaffold; the separate `jobs:run`
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

Session replacement uses one Portal DB connection/transaction. A per-UID advisory
lock serializes issuance across API processes; a bounded pre-issuance wait spaces
the single Firebase call at least 1.1 seconds from the last committed insertion.
Lock contention is bounded (3-second lock timeout; 5-second statement timeout).
The provider lifetime remains exactly `7200000` ms. Candidate equality with the
previous cookie or any persisted hash, including revoked hashes, fails closed.
Old-hash revocation and distinct-new-hash INSERT commit together, before Set-Cookie.
DB/provider failure rolls back instead of stranding the previous browser session.
There is no mutation retry, cookie wrapping, hash revival or authorization cache.
Provider uniqueness in production is not established: a repeated candidate still
returns controlled 503, preserving the old session when the transaction rolls back.

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

The generated initial Task 4 migration materializes `portalUid` (unique index),
`email` and `displayName`; database execution remains pending. Local auth checks
run real Express/Payload policies and native Fetch handlers with Firebase, pg,
internal HTTP and DB-adapter doubles. They are **not real authentication acceptance**.
PostgreSQL uniqueness/races, Firebase HTTP, Nginx and browser integration remain pending.

## Editorial model and reading contract (Task 4)

`news-articles` and `news-home` explicitly require the verified runtime Portal actor
for all reads/writes and history. Native drafts and 2-second autosave are enabled;
versions have no automatic maximum (`maxPerDoc:0` / global `max:0`). Native
`schedulePublish` is false; snapshot scheduling belongs to the publication task.
Publication/provenance fields are read-only both in admin and field access. UUIDs
are generated by the PostgreSQL adapter for native creation. The collection's
public `/create` view extension performs one authenticated native REST POST after
client mount, then opens the native document editor. Server render, metadata and
prefetch do not create articles. This avoids the pinned Payload render-time create
side effect, including Edge's `Critical-CH` navigation restart. React development
effect replay reuses the same in-flight promise; an uncertain failure offers the
list for inspection and never automatically retries creation. Autosave stays enabled.

The native header CSS allows breadcrumbs to shrink while retaining account/menu
controls. At widths up to 768px, native navigation overlays the content below the
header instead of pushing the editor into an offscreen zero-width grid column.
The page is not masked with `body { overflow:hidden }`.

Body is native Payload Blocks: richText, image, callout, quote, profile, divider,
link, PDF and video; legacy heading/paragraph/list remain native editable blocks
so all eleven old types retain their exact options. `legacyToPayloadBlocks` imports
validated legacy blocks; `normalizeNewsContent` projects either native Blocks or
validated boundary blocks. Optional layout/typography/usage have no defaults;
native UI/DB empty optional values are omitted on projection. Legacy JSON with
explicit invalid empty/null options is rejected. Populated upload relations become
flat UUIDs; no storage paths or internal metadata enter `NewsDTO`.

Editorial metadata is atomic JSON with a declared JSON schema and runtime validation,
preserving `null` for imported legacy records and civil `YYYY-MM-DD` source dates.
New native records default to empty v1 metadata (author stays empty). Trusted local
import code must pass `legacyNewsImportContext` from `news/validation.ts` when creating
an `editorial:null` record; its symbol capability cannot be sent as browser JSON.
Existing legacy null survives PATCH. Native metadata cannot be cleared to null.
PATCH replaces editorial JSON atomically; collection/global hooks validate the full
effective document including omitted fields and publication status.

For a **separate trusted local import process**, initialize a new `BasePayload`
instance with `src/payload.import.config.ts`, using the same restricted CMS runtime
role/environment. That config uses the public adapter option `allowIDOnCreate:true`,
`push:false`, no automatic migrations, and all normal collection hooks/validation.
Never serve this import-only config as the web app or toggle an initialized adapter.
Call `createLegacyNewsArticle(payload, data)` from `src/news/import-article.ts` with
the original `cms_documents.id` in `data.id`. It supplies the symbol capability,
records the same `legacyDocumentId`, retains null metadata/provenance, and verifies
returned and re-read identity in its own transaction before commit. Duplicate IDs
fail and roll back; they are not upserts. The normal config rejects this helper.
Collection hooks reject browser-selected creation IDs and changed update IDs;
JSON cannot forge the symbol capability. This is the bounded import capability,
not the later operational bundle importer or authority/cutover procedure.

The Lexical feature list is explicit: paragraph, headings, flat ordered/unordered
lists, HTTPS custom links, bold, italic, underline and inline code, plus toolbar.
Autolinks, internal relations, HTML/embed/upload nodes, styles, indentation and
unsupported marks are excluded. The public custom feature blocks list indentation;
the server rejects pasted/API nested lists and unknown serialized nodes. Conversion
preserves marks/links/breaks and maps h1 to reader h2. Limits are 100 blocks, 10,000
nodes across a document, inline depth at most 4, and 5 MiB UTF-8 of normalized
`{blocks,editorial}`. Links require HTTPS without credentials. Native links with an
omitted `newTab` checkbox project `new_tab:false`; supplied non-booleans (including
null) still fail. Explicit true/false are preserved.
Legacy import checks the normalized boundary before expanding list strings into
Payload rows; that larger persistence representation does not have a second 5 MiB
cap. Document validation includes the editorial metadata in the aggregate limit.

Publication requires title; native articles need summary and meaningful paragraph,
list, quote or profile body (rich paragraphs/lists included); editions need any PDF.
`validateNewsDraftStorage` lets native draft/autosave hooks retain unfinished block
fields (empty quote text, null rich content, media or alt not yet selected). It
validates every supplied field and the full effective PATCH, using a partial
boundary projection only for shared usage/budget checks; the original native
data is returned untouched. Supplied unsafe text/URLs, malformed IDs, unknown
keys/nodes, invalid dates, duplicate usages and excessive budgets still fail.
Native text and row labels/IDs are also shape/length bounded. Missing fields are
not padded with invented content. Publication, DTO projection (including preview),
legacy JSON and trusted legacy imports still require complete block shapes.
DTOs emit version 2 and
`owner-news` or `owner-news-preview` asset scope. Reading time uses 200 words/minute,
excludes attachment names/metadata and is null for editions, empty text, or legacy
null metadata with any PDF. It never invents authorship.
Home publication requires nonempty eyebrow/headline/summary, with raw length limits
80/160/600 and line breaks permitted only in the headline, matching the legacy home.

Task 5 replaces the deny-all media scaffold with the private media boundary below.
`validateNewsMediaShapes` remains a pure metadata check; actual publication also
checks file existence, safe storage identity, size and SHA-256 under the CMS lock.
Scheduling, full publication/audit snapshots, cutover and the integrated native
browser journey remain later integration gates.

## Private media and reference protection (Task 5)

- Uploads accept JPEG/PNG/WebP, PDF, MP4/WebM/QuickTime, with **50 MiB** maximum
  both in the multipart parser and raw-buffer validation. Signature/container
  checks do not establish full PDF/codec validity or malware safety. Sharp decodes
  images with an **80,000,000-pixel** ceiling, including all WebP frames.
- Start the CMS through its `cms/` scripts. `CMS_UPLOAD_DIR` must be an absolute
  private directory outside the checkout (including `public/`). Storage reads use
  canonical paths, reject symbolic-link files and invalid UUID filenames, open a
  descriptor with `O_NOFOLLOW` where available, and verify the original SHA-256.
  The service account must be the only untrusted-write boundary for that directory;
  this is not a defense against a privileged process concurrently replacing files.
- The server assigns UUID filenames. All updates, replacement, crop, duplicate,
  overwrite, remote URL and temp-file inputs are rejected in native
  **beforeOperation**, including Local API calls with `overrideAccess:true`.
  Metadata alt/caption/credit stays on the article reference. Create a new asset
  to replace or crop. `pasteURL:false` also disables the native paste-URL fetcher.
- Payload's global image transformer is deliberately absent: its WebP path
  re-encodes even without resize options. Sharp validation is separate and does
  not save its output. Hashes describe the original uploaded bytes, not a derivative.
- Native metadata and file routes require the current Portal editor capability.
  The native file handler always delegates to safe descriptor delivery; it never
  falls back to Payload's path-based serving. No public static mount is added.
- `openNewsMedia({payload,id,preview,actor,range,req})` is a **server-only helper**,
  not an HTTP bridge. The future API reader must pass a freshly verified
  `VerifiedPortalActor`, never a body-cast actor. Preview requires editor capability;
  readers need a valid currently published article referencing the asset. Draft or
  old version alone is not a grant. Shared assets remain readable while any valid
  current publication references them. The body is a cancelable Web stream; request
  abort, cancel, EOF or read failure closes the descriptor. PDF/video support one
  Range (206/416). Headers include private/no-store, nosniff and sanitized disposition.

### Transaction contracts for Tasks 6/11/12

`publication/transaction.ts` exports `CMS_REFERENCE_LOCK` (**7194030**),
`requireCmsTransaction`, `lockCmsReferences` and `withCmsTransaction`. Native
operations start their transaction before collection beforeOperation; the hooks
lock its actual PostgreSQL adapter session **before** authority resolution and the
native original-document/version snapshot. Missing/dead sessions fail closed;
the adapter's default-connection fallback is never used by these helpers. Every
subordinate Local API call receives that live `req`. Native code owns native
commit/rollback. Standalone helpers own only the transaction they create, and
descriptor-open precedes release. Lock contention is bounded by a 5-second local
lock timeout. The legacy Portal lock **7193029** is unchanged.

`assertCmsWriteAuthority` resolves `createPortalClient(environment).getAuthority()`
on every mutation without caching. Normal article/media writes require `payload`;
frozen/unavailable/legacy modes fail closed. Read/login/preview are unaffected.
The existing server-only `legacyNewsImportContext` allows preparation imports in
`legacy`, but never in either frozen mode. Caller-ID preservation still requires
the separate import config. This is not the Task 11/12 operational import protocol.

`normalizeNewsDraftReferences` is a bounded incomplete-native projection: selected
media is retained even without alt/title. `collectMediaIds` consumes only the flat
normalized projection, not recursive JSON or regex discovery. Orphan deletion
scans current documents and **all native versions**, in pages of 100 (100,000-row
maximum per store; exceeding it refuses deletion). New schedule/snapshot/history
stores must extend the explicit coverage check and protection before orphan
deletion can succeed. Unknown collections/globals, new article/home top-level
fields, scheduling configuration or finite history retention fail closed.

Two intentional pilot restrictions prevent native lifecycle escape hatches:
article physical deletion is refused because Payload deletes all its versions;
article bulk update is refused because native concurrent document promises can
roll back their shared session while sibling operations are still running. Use
single-document edits/unpublish. Task 6 must explicitly handle **global**
`restoreVersion`, which does not run global beforeChange; this task does not
extend the home publication/audit lifecycle. Collection article restore is locked
and runs its normal validation hooks.

The generated media migration makes SHA-256 required. Existing media with null
hashes must be reconciled with verified private bytes before applying it; the
migration intentionally does not invent hashes or mutate sample databases.
Native file writes/unlinks are not PostgreSQL-transactional: a failed create may
leave an unreferenced file, and a failed orphan-delete commit may leave metadata
without bytes. There is no automatic cleanup. Missing/corrupt files fail closed.

### Focused local evidence and acceptance boundary

`npm --prefix cms run test:unit` exercises real files, decoding, hashes, Range,
abort/cancel and pinned native operation lifecycle with **explicit DB/Portal
transport doubles**. It does not establish PostgreSQL lock semantics or real auth.
The dedicated native/DB runner is:

```sh
node cms/tests/integration/run-task5.mjs --disposable-task5
```

This Windows local-validation helper reads the existing private validation state,
only connects to `127.0.0.1:55441`, creates/resets **cms_task5_test only**, applies
CLI migrations as `cms_migrator`, runs native operations as `cms_runtime`, and keeps
synthetic files/logs in a fresh approved `Temp/opencode/ownerinc-task5-*` directory.
It does not modify `cms_validation`, `portal_upgrade`, sample fixtures or their
authority; it does not start/restart Docker. It refuses reset/test if other
connections exist in the dedicated DB. To diagnose existing synthetic fixtures
without resetting/migrating, append `--reuse-private-dir <existing ownerinc-task5-* directory>`.
Diagnostic logs are timestamped; original failure evidence is retained.

The first attempt encountered **ECONNREFUSED**. After the primary restored only
the approved PostgreSQL container, real migration/native tests exposed an invalid
test fixture: a restore-success Image block referenced a PDF. The success fixture
now uses PNG and retains missing alt; a separate regression confirms incompatible
PDF-as-image restore still fails. The corrected real native suite passes all
nine subcases (ten tests including parent), with Portal authority HTTP explicitly
still a **transport double**. This is not full-stack authentication acceptance.

The harness disables only development background type generation. Pinned Payload
`connectWithReconnect` retains a checked-out listener client; `destroy` clears
schema caches without ending the pool, and `pool.end()` cannot finish while that
client is held. The isolated Node24 runner therefore uses `--test-force-exit`
after tests/hooks, not a forced success status. Tests assert zero live sessions,
DB transactions/reference locks and pool waiters; the launcher verifies zero
leftover DB connections after exit. A subprocess regression verifies failures
still exit 1. TAP and distinct timeout/spawn/signal reporting preserve failures.
No node_modules or production connection lifecycle is changed.

Linux symlink behavior remains an acceptance gate (Windows EPERM prevented
creation of the symlink test fixture). See the private Task 5 report for exact runs.

## Subsequent real local validation of Tasks 1–4

The isolated PostgreSQL/Firebase Emulator/Express/Next validation was executed
after the original task reports. See the [real validation record](../docs/reviews/2026-10-02-payload-tasks-1-4-real-validation.md):
35 cases passed and 2 failed in that historical backend run (supplied import UUID
preservation and same-second emulator session reissuance). Real migrations, restricted runtime
roles, HTTP authentication and native persistence were exercised. Browser and
missing Task 5/9/13 capabilities remain pending. The earlier “pending” statements
above describe the individual task delivery gates; this record supplies the
subsequent evidence without claiming full acceptance.

The [2026-10-03 remediation/rerun](../docs/reviews/2026-10-03-payload-five-fixes.md)
records fixes and new real evidence for those two failures and the three later
Edge failures. It preserves the historical failures as observed at that time.
`idType:'uuid'` alone still does **not** preserve a supplied ID; use only the separate
trusted import capability described above. No operational importer is delivered here.

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
