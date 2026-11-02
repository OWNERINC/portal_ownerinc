# Work Package 3 — Staged Manual-Editorial Profile Implementation Plan

## Steps

- [ ] Wait for B0 package integration, completed review and CI on a stable tree, then receive the separate bounded implementation prompt.
- [ ] Implement and qualify immutable held/editorial configuration, descriptors, readiness assertions and schema-neutral profile selection.
- [ ] Implement and qualify revocable strict-News Versions access and early draft/autosave intent normalization.
- [ ] Implement and qualify transaction-safe article/Home restore-to-new-draft, immutable identity preservation, audit provenance and media protection.
- [ ] Implement and qualify supported Versions-detail controls, explicit draft checkpoints and saved-preview behavior.
- [x] Implement and qualify opt-in v2 profile evidence while preserving existing held-only v1 preflight behavior.
- [ ] Complete the bounded native/API/browser verification, same-database profile restart proof and matching documentation; report every unexecuted or incomplete case accurately.
- [ ] Hand the qualified cold package and exact evidence interfaces to the primary; retain production admission as a separate operational integration requiring qualified active/frozen recovery.

## Authorization, dependencies and verification status

**Goal:** Support staged autosave, revocable Versions access and safe restoration into new drafts while retaining manual publication and keeping workers/scheduling off.

**Architecture:** Two immutable, versioned editorial profiles share one qualified CMS image and the existing native version tables. Article restoration uses guarded native restore with `draft:true`; Home restoration uses guarded normal `updateGlobal` draft saving. Profile selection and evidence are separate from authenticated operational promotion.

**Tech stack:** Existing Payload `3.90.2`, Next `16.4.2`, React, TypeScript, PostgreSQL native versions, Node 24 CMS tooling, existing Portal session bridge and leased Linux native/browser fixtures. Preserve Node 18 compatibility in shared API/cron code and the approved Node 24 CMS/checks exception.

**Status:** The primary approved the technical design under user delegation. This document records that approved design; approval of the design is not verification of its implementation or authorization for production admission.

**Current authorization:** Write this plan file only. No repository code/test changes, agents, commits, GitHub operations, SSH, database operations or services are authorized by the plan-writing request. No implementation starts from saving this file. Actual implementation requires a separate bounded prompt after B0 integration, review and CI have stabilized the tree.

**Mandatory dependencies:**

1. Wait for the active B0 package to integrate and complete review plus CI before starting this cold package. Do not re-review its gate or take ownership of its runtime/state/preparer files.
2. Qualified active/frozen recovery is required **before ANY production editorial-profile admission**, even if cold configuration/editorial tests have passed. This is a separate operational dependency owned by the primary.
3. Existing v1 cutover continues using the held profile until separate operational integration supplies and validates authenticated profile expectations and phase-compatible resume evidence.
4. **No positive pre-cutover production editorial writes.** Positive editorial rehearsal belongs to isolated qualified fixtures; productive editing begins only after the separately authorized and observed Payload activation/admission sequence.
5. Worker/scheduling remain off in every profile and every phase covered by this plan.
6. All design verification is **PENDING / NOT EXECUTED**. There are no new PASS claims. Source inspection established the facts recorded below, not native/API/browser correctness, schema-switch qualification, production readiness or completed OWN-24/31 acceptance.
7. Preserve every constraint in sections 1–13. During later implementation, tick completed coarse steps without dropping constraints; blocked operational dependencies remain explicit.
8. Repository guidance still applies: read `README.md`, `docs/product/brief.md` and relevant documentation before code changes; keep changes localized; preserve service boundaries and LF for Linux-related files; do not hardcode credentials or alter production deploy scripts under this cold-package scope. Future service-affecting Docker execution needs explicit authorization.

The following thirteen sections preserve the approved technical specification. Commands and test cases below are future execution instructions and requirements, not records of execution.

## 1. Decision and scope

Implement **two versioned editorial profiles in the same qualified CMS image**, retaining `CMS_PUBLICATION_MODE=manual`:

- **`held-v1`** — default; explicit draft saving/publication remains available subject to existing authority checks; autosave, editor-facing Versions and restoration remain disabled.
- **`editorial-v1`** — autosave, revocable Versions access and restoration into a **new unpublished draft**.

Use **native article restore with `draft:true`**, entered through a guarded restore service. For Home, use **normal `updateGlobal(..., draft:true, autosave:false)`**, because the pinned native global restore does not provide the required isolation.

This package delivers configuration support, editorial behavior, versioned evidence contracts and tests. **Production profile promotion belongs to the primary’s later active-phase integration.**

### Source findings that determine the design

| Checked source | Consequence |
|---|---|
| `NewsArticles.ts:17–20`, `NewsHome.ts:12–13` | Current configuration deliberately disables autosave and history. |
| `publication/hooks.ts:26–35` | Article restoration currently misinterprets the version ID as a document ID if its rejection is simply removed. |
| Payload `collections/operations/restoreVersion.js:24–35` | `id` and `draft` are captured **before** `beforeOperation`; a hook cannot safely convert an ordinary restore into a draft restore. |
| Same operation, `:239–263` | `draft:true` skips the article’s live-row update and creates a new non-autosave version. |
| Payload `globals/operations/restoreVersion.js` | Native global restore writes the live global and bypasses normal `beforeChange` processing. It remains prohibited. |
| Payload `collections/operations/utilities/update.js:40`, `globals/operations/update.js:79` | Native draft/live-row selection happens before `beforeChange`. Draft intent must be normalized earlier. |
| Payload `versions/saveVersion.js:20–38` | Consecutive autosaves may update the latest autosave row. An autosave ID is not an immutable checkpoint. |
| Initial migration, `:389–408`, `:489–507`, indexes at `:651,683` | Both native version tables already contain `latest`, `autosave` and the required content/provenance fields. |
| `api/owner-news/payload-dto.js:154–167`, `cutover.js:231–247` | Current preflight consumers explicitly require autosave and Versions to be false. |

**No new database table, column, enum or migration is proposed.** Schema compatibility remains a native-test requirement, not a claim inferred solely from migration text.

## 2. Configuration contract

### Environment

Add **`CMS_EDITORIAL_PROFILE`**:

| Input | Result |
|---|---|
| Absent | `held-v1` |
| Exactly `held-v1` | Held profile |
| Exactly `editorial-v1` | Editorial profile |
| Empty, whitespace-padded, unknown or future value | Configuration error |

`CMS_PUBLICATION_MODE` remains required and accepts only the exact value `manual`.

The normal build-only configuration uses `held-v1`. Both profiles’ components must nevertheless be present in the generated import map and compiled image. Tests construct both configurations explicitly; production never inherits a test override.

### Capabilities

| Capability | `held-v1` | `editorial-v1` |
|---|---|---|
| Native drafts | Enabled | Enabled |
| Explicit draft save | Enabled | Enabled |
| Explicit publication/withdrawal | Existing guarded behavior | Same guarded behavior |
| Autosave | Disabled, including direct API attempts | Enabled, **1,500 ms** interval |
| Article version retention | `maxPerDoc:0` | `maxPerDoc:0` |
| Home version retention | `max:0` | `max:0` |
| Editor `readVersions` | Denied | Current strict News editor |
| Article restore | Denied | Guarded native restore to new draft |
| Home restore | Denied | Guarded normal update to new draft |
| Native global restore | Denied | Denied |
| Scheduled publication | Disabled | Disabled |
| Schedule collection/endpoints/UI | Omitted | Omitted |
| Publication tasks/job auto-run | Empty | Empty |
| Worker operation | Held/off | Held/off |

Make collection/global configuration factories accept the resolved profile. Produce fresh configuration objects; do not mutate shared `NewsArticles`/`NewsHome` exports or change a running Payload instance’s configuration.

Profile decisions during requests must come from the **loaded Payload configuration**, not a fresh environment read that could disagree with the running adapter.

### Capability descriptor and hash

Define a closed, immutable descriptor containing:

- `descriptorVersion:1`;
- `profileId`;
- `publicationMode:'manual'`;
- `payloadVersion:'3.90.2'`;
- article and Home draft support, autosave interval or `false`, and version-retention limits;
- history policy: `deny` or `current-news-editor-v1`;
- article restore policy: `deny` or `native-new-draft-v1`;
- Home restore policy: `deny` or `update-global-new-draft-v1`;
- schedule publication, schedule endpoints and worker configuration, all false;
- publication task list and auto-run list, both empty.

Define `profileSha256` as SHA-256 of the UTF-8 bytes of:

**`ownerinc.cms.editorial-profile.v1` + newline + existing `canonicalJSON(descriptor)`**.

Use the existing canonicalization algorithm unchanged. Reject unknown descriptor fields and contradictory capability combinations.

A configuration assertion must compare the descriptor with the sanitized collection/global/job/endpoint configuration. Merely returning the expected descriptor literal is insufficient.

## 3. Configuration evidence versus operational authorization

The descriptor/hash identifies configured behavior. **It is not permission to activate that behavior.**

### Cold-package evidence

Provide:

1. Deterministic descriptors/hashes for both profiles.
2. Assertions against the actual loaded configuration.
3. Private readiness response headers:
   - `X-CMS-Editorial-Profile`
   - `X-CMS-Editorial-Profile-SHA256`
4. Versioned preflight support described below.
5. Tests proving that the same image and existing database can run both profiles without DDL.

Keep the existing readiness JSON shape. Emit profile headers only after configuration validation and successful readiness checks.

### Required later promotion binding

The primary’s authenticated operational evidence must bind this exact tuple:

| Field | Required meaning |
|---|---|
| `bindingVersion` | `1` |
| `purpose` | `cms-editorial-profile-promotion` |
| `requestId`, `deadline` | Fresh operation identity and canonical absolute expiry, maximum 60 minutes |
| `previousStateSha256` | Exact authenticated operational state being advanced |
| `targetBindingSha256` | Existing canonical target inventory, including physical databases and upload-store identities |
| `releaseDigest`, `cmsImageDigest` | Exact qualified deployed release/image |
| `fromProfileSha256`, `toProfileSha256` | Held and editorial descriptor hashes |
| `nativeCatalogFingerprint` | Qualified existing native schema |
| `authorityEpoch` | Freshly observed Payload authority epoch |
| `activation` | Exact manifest, seal, activation release/image digests and activation request ID |
| `observationSha256` | Authenticated evidence of completed Payload activation observation |

The existing operational trust mechanism authenticates this binding. Browser input, an environment hash, readiness headers alone, or an unsigned JSON file cannot supply that authorization.

For this package, promotion uses the **same qualified image** that supported the held profile. Later image replacement is a separate release operation.

The later operational sequence must hold writer admission, drain requests, recreate CMS with the selected profile, verify target/image/catalog/profile/readiness and fresh authority, then reopen admission. It must not reset the mutation ledger, replay migrations or replace the original activation seal.

## 4. Versions access and revocation

Add a dedicated history gate. Do **not** reuse `canManageNews` without narrowing: it currently also recognizes a generic v2 Knowledge capability.

An editor-facing history read requires:

1. `portal-editors` identity with the existing strict verified News actor.
2. Matching projected UID and resolved Portal UID.
3. Current, unexpired strict editorial session.
4. Fresh Portal session resolution and current News permission.
5. `editorial-v1` loaded.
6. Authority:
   - `payload` with `activationObserved=true`; or
   - `payload_frozen` with a valid existing activation binding, for read-only inspection.

Deny history in `legacy`, initial `frozen`, and `held-v1`.

Apply this to native Versions list/detail/count access, the custom version-detail view and restore-source reads. Application-owned calls use `overrideAccess:false`. Existing server-only retention/publication inspection may retain its explicitly privileged access.

### Revocation behavior

- Resolve permissions on every request; only request-scoped deduplication is allowed.
- Do not cache authorization across requests or in the editor projection.
- Re-resolve the strict session **after lock acquisition** for restoration, so logout/revocation during the lock wait is detected.
- Dependency failure returns unavailable; it must not become an empty successful history response.
- Version content uses private/no-store responses and no shared RSC/data cache.
- The custom history view revalidates on focus, visibility restoration and BFCache return; denial clears displayed content and disables restore.
- Existing `SessionWatch` remains the surrounding identity/session boundary.

Revocation cannot retract bytes already delivered, but every subsequent request and renewed display must be denied.

## 5. Safe restore interface and editor UI

### One application-owned restore service

Expose a bounded same-origin endpoint:

**`POST /editorial/api/news-restore-draft`**

Its exact request fields are:

- `target`: `news-articles` or `news-home`;
- `documentId`: article UUID, or literal `news-home`;
- `sourceVersionId`: native version UUID;
- `sourceRevisionToken`;
- `expectedHeadToken`.

No caller-supplied content, actor, publication status, generation, provenance or access-override option is accepted.

Tokens are server-generated SHA-256 values over a versioned canonical representation containing target, parent/document identity, version ID, saved timestamp, autosave/status flags and the bounded depth-zero stored version content. Exclude mutable bookkeeping such as `latest`. Including content is necessary because an autosave row can change without changing its ID.

The version-detail read supplies these tokens. Restoration revalidates them inside its transaction.

Success returns only the target, document ID, source version ID, **new** version ID, saved timestamp and `_status:'draft'`, after commit. Reject stale source/head tokens with 409. A retry carrying the old head token must not silently create another restoration.

For a lost response, the UI refreshes history and reconciles the latest revision/provenance before offering another restore.

### Native entrypoints

- Ordinary article `restoreVersion` calls remain denied unless entered through the server-only restore scope.
- Even within that scope, require `args.draft === true` at entry.
- Native Home `restoreVersion` remains unconditionally denied.
- `overrideAccess:true` must not bypass these hook guards.
- A JSON context field, including Payload’s `isRestoringVersion`, never grants restoration authority.

Use an unforgeable server-side scope bound to the live transaction/session, actor, target, source version and resolved parent. Propagate it through Payload’s request/context copies and clear it in `finally`. Do not rely solely on request-object identity: native article restoration creates a locale-isolated request for later hooks.

### Supported UI wiring

Keep the native Versions list and navigation. Replace the version-detail view through:

**`admin.components.views.edit.version.Component`**

This extension exists for both collections and globals in Payload 3.90.2.

The custom view provides:

- source version identity, saved time and status;
- read-only comparison with the current saved draft;
- one action: **“Restaurar como novo rascunho”**;
- confirmation that publication remains unchanged;
- disabled restoration while read-only, denied, busy or conflicted;
- reload of the editor with the resulting saved draft after success.

Validate that every article version displayed belongs to the document in the route, including comparison versions.

Do not patch `node_modules`, hide the unsafe button with CSS, or deep-import the internal native Version view. The inspected public `@payloadcms/next/views` export does not expose that view for supported composition.

## 6. Transaction and hook ordering

### Shared restore order

1. Validate request shape and configured capability.
2. Start or join a CMS transaction using existing transaction helpers.
3. Acquire advisory reference lock **7194030**.
4. Freshly verify strict session, actor, `payload` authority and activation observation.
5. Resolve the source version in the correct native version store.
6. Resolve and validate its parent/target.
7. Lock the live document row.
8. Re-read/verify source identity, source token, current head and current live base.
9. Check current editing-lock policy; restoration does not silently take over another editor’s lock.
10. Validate restorable content and referenced media.
11. Execute the native article restore or safe Home update.
12. Verify the resulting new revision and append audit in the same transaction.
13. Commit, then return success.

Every database operation carries the live transaction request. `requireCmsTransaction` must continue failing closed rather than falling back to a pool connection.

The reference lock serializes application saves, restoration and media deletion. Use the existing row-lock helper after parent resolution; do not invent a new locking order.

### Article-specific resolution

In `operation === 'restoreVersion'`:

- **`args.id` is the version ID.**
- Resolve the source using the native version store and the current transaction.
- Require a valid `rawVersion.parent`.
- Require that parent to equal the endpoint’s article `documentId`.
- Lock/load that parent, not `args.id`.
- Preserve `args.id` as the version ID when invoking native restoration.

Call native restore with `draft:true` **already supplied**. Changing `args.draft` inside `beforeOperation` is too late.

The service must explicitly check history permission as well as update permission: native article restore’s own update-access check does not replace history authorization.

### Home-specific restoration

Read the source through `findGlobalVersionByID` for `news-home`. Require an existing live base for restoration; a missing base is an error, not a reason to bootstrap a replacement.

Project only:

- `eyebrow`;
- `headline`;
- `summary`.

Then call normal `updateGlobal` with:

- `draft:true`;
- `autosave:false`;
- `_status:'draft'`;
- current request/transaction;
- access checks enabled;
- editing-lock override disabled.

That path executes the ordinary Home publication/validation/audit hooks and skips the live global write when saving a draft.

Normal first-time Home editing retains its existing guarded base-row bootstrap behavior. Restoration does not use it.

## 7. Immutable identity and restoration provenance

Restoration copies **editorial content**, not historical identity/control state.

For articles, the restorable content projection is:

- `title`;
- `category`;
- `editorial`;
- `body`.

From the current locked live base, preserve:

- document identity;
- document `createdAt`;
- `publishedAt`;
- `publicationGeneration`;
- `legacyDocumentId`;
- `legacySourceId`;
- `legacyRevisionId`;
- `importedAt`.

Apply equivalent preservation to Home.

Overwrite these fields explicitly in the restore preparation path, including null values. Merely deleting historical values from `data` is insufficient: native field processing can merge values from the historical version or latest draft.

Do not:

- regenerate document IDs;
- copy a historical publication generation;
- change public ordering timestamps;
- manufacture legacy metadata;
- use import capability to bypass current validation.

The existing rule prohibiting a transition from non-null `editorial` to imported `null` remains enforced. An incompatible historical revision produces a bounded conflict/validation response.

Native article restore can carry historical `createdAt` into the version wrapper. **Restoration time is identified by the new version’s `updatedAt` and the new audit record**, not by assuming every version wrapper has a new `createdAt`.

### Audit

Keep the existing action **`draft_saved`**. Extend the bounded `details` allowlist with:

- `saveKind`: `manual`, `autosave` or `restore`;
- for restoration:
  - `sourceVersionId`;
  - `sourceRevisionToken`;
  - `sourceStatus`;
- resulting editorial `snapshotHash`, using the existing field;
- existing target and current generation.

The audit row’s `versionId` identifies the **new resulting revision**; `details.sourceVersionId` identifies its origin.

Actor and provenance come exclusively from verified transaction state. Audit failure rolls back restoration. No new action enum or SQL structure is needed.

## 8. Autosave and published-base correctness

### Normalize intent before native draft/live selection

Add an early `beforeOperation` intent guard for article create/update and Home update.

| Request intent | Required interpretation |
|---|---|
| `autosave:true` | Require editorial profile; force `draft:true` and `_status:'draft'` |
| `draft:true` | Force `_status:'draft'`, even if supplied as `published` |
| Explicit `_status:'published'`, without draft/autosave intent | Explicit publication |
| Explicit `_status:'draft'`, without draft/autosave intent | Existing explicit withdrawal semantics |
| No explicit status or draft/autosave intent | Normalize to draft saving; do not infer publication from the existing document |

Reject conflicting publication/locale/bulk controls that could defeat this single-status contract.

The publication `beforeChange` hook repeats the draft-status invariant defensively, but it is **not** the primary protection. Native `isSavingDraft` must already have been selected correctly.

### Authoritative state

Keep two concepts separate:

- **Live base:** loaded from the main article/global row under lock; authoritative for publication identity, generation and published timestamps.
- **Latest saved draft:** native version content used for partial editor updates.

Do not treat native `originalDoc` as the authoritative live base; it may represent the latest draft.

Autosave and restore must leave unchanged:

- the live public row and its content;
- public status;
- `publishedAt` and publication generation;
- reader feed/detail/Home results;
- public media grants.

They create/update only private version state plus the corresponding audit/ledger effects.

Publication still performs full content/media validation. Safe incomplete drafts remain accepted.

### Saved checkpoints and preview

Retain explicit draft checkpoints alongside autosave. Payload hides its ordinary Save Draft control when autosave is enabled, so add a small supported control using the native form submission API with `draft:true`, `autosave:false`, `_status:'draft'`.

This gives editors a deliberate, non-coalescing revision for A/B history and preview.

For the saved-preview workflow:

- retain dirty/upload/background-save blocking;
- keep GET read-only;
- return the actual native version ID, never the document ID;
- when the latest revision is an autosave row, require an explicit checkpoint before presenting it as a stable saved-revision preview;
- return a clear 409 instruction rather than silently creating a version during GET.

Consecutive autosaves are allowed to coalesce. Tests must not demand one permanent version per keystroke.

A later accepted autosave may create a newer private draft after a restoration. It must not mutate the new non-autosave restored checkpoint or publish anything. Restore head-token checks protect against changes committed **before** restoration; this package does not introduce a general collaborative-editing protocol.

## 9. Media and schema stability

### Media

Preserve the existing reference lock and retained-version scan.

For autosave and restoration:

- validate bounded draft structure;
- allow incomplete captions/alt text;
- validate every selected, non-null media reference for identity, existence, compatible type and available stored bytes;
- perform reference checks under the same transaction/lock before committing the version;
- retain immutable original media.

Reuse the existing draft-reference projection. Do not run publication-only completeness validation merely to check whether an incomplete draft’s selected asset exists.

An asset referenced by any retained native revision remains protected from deletion. An asset referenced only by a draft or old revision does **not** thereby receive public-reader access.

Keep article deletion’s history-retention denial and both unlimited version-retention settings. No pruning job is added.

### Schema-neutral switch

The existing physical schema is the common superset for both profiles.

One important distinction: Payload’s in-memory version-field builder includes the `autosave` field only when autosave is enabled. Therefore:

- require equal **physical catalog/migration fingerprints**, not identical in-memory field lists;
- retain `push:false`;
- do not generate a held-profile migration that drops the existing autosave columns/indexes;
- add required autosave/latest columns to the existing readiness catalog assertions;
- verify existing audit `details` accepts the new bounded provenance without schema changes.

The native proof must migrate once, then run:

**held → editorial → held → editorial**, using the same database and image, with no intervening DDL.

It must preserve IDs, versions, content, media, audit and migration history across every restart.

## 10. Initial versus resume preflight

### Existing contract: preserve it

The current unversioned preflight remains **v1**:

- exact existing response shape;
- held profile only;
- runtime capability flags all false;
- unchanged initial empty-domain/zero-ledger and seal checks.

If the loaded profile is editorial, a v1 request fails closed. It must never manufacture false capability flags.

### Explicit v2 support

Add an opt-in input discriminator **`preflightVersion:2`**, with:

- `expectedEditorialProfile.id`;
- `expectedEditorialProfile.sha256`.

V2 returns the existing evidence plus:

- `preflightVersion:2`;
- the actual editorial descriptor and its hash.

The existing `runtime` capability booleans describe **configured capabilities**. Under frozen authority, autosave may be configured but writes remain denied.

| Phase | Compatible profile | Required behavior |
|---|---|---|
| `legacy`, initial preflight | Held only | Existing empty counts, zero sequence/chain and unbound open barrier |
| Initial `frozen` | Held only | Existing empty destination and exact sealed-run evidence |
| `payload_frozen`, resume | Exact profile bound by approved resume evidence | Populated content allowed; writes denied; original activation binding retained |
| `payload`, observed | Operational promotion/readiness path | Not a new initial-cutover shortcut |

Resume may use either approved profile; it must not arbitrarily select held just because an environment variable disappeared. Compare the expected profile with the actual loaded configuration.

The profile addition must not redefine the original migration seal as a current-content digest, require an active database to become empty, or alter barrier/recovery semantics. Those remain the primary’s active-phase contract.

Cold work can add strict v2 CMS parsing/output and Portal DTO validation. **`api/owner-news/cutover.js` continues requesting v1 until the primary integrates authenticated profile expectations and resume handling.** This prevents configuration support from silently enabling operational promotion.

## 11. Owned files

The following is the proposed implementation ownership boundary.

### Existing application files

- `cms/src/config/environment.ts`
- `cms/src/config/readiness.ts`
- `cms/src/app/editorial/ready/route.ts`
- `cms/src/payload.config.ts`
- `cms/src/collections/NewsArticles.ts`
- `cms/src/globals/NewsHome.ts`
- `cms/src/publication/hooks.ts`
- `cms/src/publication/authority.ts` — bounded post-lock interactive-session revalidation
- `cms/src/publication/document.ts` — revision/token helpers
- `cms/src/publication/audit.ts`
- `cms/src/publication/go-live-preflight.ts`
- `cms/src/auth/service-access.ts`
- `cms/src/news/validation.ts`
- `cms/src/media/references.ts`
- `cms/src/endpoints/saved-preview.ts`
- `cms/src/admin/SavedPreview.tsx`
- `cms/src/admin/preview-state.ts`
- `cms/src/app/(payload)/editorial/admin/importMap.js` — generated component registration
- `api/owner-news/payload-dto.js` — explicit v2 input/result validation

`NewsAudit.ts`, publication fields, migrations and generated document types should need no schema change.

### New focused modules

- `cms/src/config/editorial-profile.ts`
- `cms/src/auth/news-history-access.ts`
- `cms/src/publication/draft-intent.ts`
- `cms/src/publication/restore-draft.ts`
- `cms/src/endpoints/news-restore-draft.ts`
- `cms/src/admin/NewsVersionView.tsx`
- `cms/src/admin/RestoreDraft.tsx`
- `cms/src/admin/SaveDraftCheckpoint.tsx`

### Tests/documentation

- Existing manual-profile, preflight, validation, audit, media and preview unit tests.
- New focused profile/access/restore/native-lifecycle unit tests.
- `cms/tests/integration/editorial-runtime.ts`
- `cms/tests/integration/functional-editorial.mjs`
- `cms/tests/integration/functional-matrix.mjs`
- `scripts/integration/payload-manual-runtime.mjs`
- `scripts/integration/payload-functional-run.mjs`
- `scripts/integration/payload-functional-fixture.mjs`
- Matching runner contract tests.
- `docs/operations/payload-owner-news.md`
- `docs/reviews/2026-10-02-payload-owner-news-acceptance.md`

**Reserved for the primary:** operational profile promotion, cutover dispatch/consumer wiring, active recovery/admission transitions and production configuration. All `ops/` runtime/state/preparer files remain outside this package, as do B0 implementation and gate review.

## 12. Verification and runner reuse

### Required cases

| Area | Native/API/browser assertions |
|---|---|
| Profiles | Default held; invalid input rejected; both profiles retain manual publication and empty scheduling/jobs configuration |
| Actual configuration | Descriptor/hash matches sanitized config; contradictory injected flags fail |
| History | Held denied; strict editor allowed; reader/generic v2 denied; expiry, permission removal, revoked cookie and dependency failure handled |
| Article restore | Version ID differs from parent; wrong-parent/missing/stale source rejected; correct new draft created |
| Home restore | Native global restore denied; guarded normal update creates draft while live Home remains unchanged |
| Publication isolation | Restore published A over current published B; readers continue seeing B until explicit publish |
| Early draft guard | `draft=true`/`autosave=true` with `_status:'published'` cannot write live content |
| Identity | Historical generation/timestamps/import metadata cannot roll back current identity |
| Atomicity | Validation/media/audit failures leave no committed restored version or partial audit |
| Concurrency | Source autosave changes, head changes, lock wait expiry, competing restore and repeated old request |
| Autosave | Incomplete draft accepted; coalescing understood; manual/restore checkpoint not overwritten by later autosave |
| Media | Version-only reference blocks deletion; drafts do not grant reader access; missing bytes fail safely |
| Preview | Pending state blocked; exact saved version ID; explicit checkpoint required for stable preview; GET creates nothing |
| Preflight | V1 held compatibility; v1 editorial rejection; initial v2 held-only; resume exact-profile matching |
| Persistence | Same-database profile restart cycle with unchanged physical schema and preserved lineage |

For publication isolation, inspect both the actual native live rows and reader-facing results. Hook mocks alone cannot establish this.

### Existing offline commands

```text
npm run test:cms
npm run typecheck:cms
npm run verify
```

Run a production build with `CMS_BUILD_ONLY=true` to verify import-map coverage and both profiles’ runtime-selectable components. These are future implementation checks; none were executed for this specification.

### Best native runtime reuse

Reuse:

- `scripts/integration/payload-manual-runtime.mjs`;
- its owned disposable PostgreSQL/protocol/storage setup;
- its real CMS HTTP process;
- `manual-runtime-content.ts` patterns for independent persisted-state assertions.

Existing Linux entrypoint:

```bash
PAYLOAD_MANUAL_RUNTIME_DISPOSABLE=1 \
  node scripts/integration/payload-manual-runtime.mjs
```

Extend that harness with explicit held/editorial phases and `editorial-runtime.ts`, while retaining its declared Portal transport double.

**A fixture correction is required:** the HTTP authority double at `payload-manual-runtime.mjs:157` currently omits `activationObserved`, although the current Portal client requires it. Return a complete, internally consistent synthetic authority response; do not weaken production validation to accommodate the fixture.

This runner proves real native persistence and API behavior with a doubled Portal boundary. It does not prove real session revocation or production activation.

### Best browser reuse

Reuse the leased HTTPS stack, real Portal API, Firebase Emulator, Nginx and Chromium support:

```bash
node scripts/test-payload-integration.mjs --matrix
node scripts/test-payload-integration.mjs --prepare-lease
node scripts/test-payload-integration.mjs --execute --lease "$LEASE_PATH"
```

Add an explicitly selected editorial fixture phase and `functional-editorial.mjs`. Preserve the existing preauthority integrity slice rather than inserting productive writes into it.

The editorial phase must identify its isolated authority/admission setup explicitly. Fixture setup is not evidence that production Gate E was executed.

Current limitations must remain visible:

- only eight preauthority cases are implemented in the current 44-case matrix;
- successful execution currently remains `INCOMPLETE`, exit 2;
- current PUB-01/PUB-05 expectations are held-profile expectations;
- passing the new bounded editorial suite must not mark unrelated matrix cases complete.

Do not use historical `task6-native.ts` as the runner: it contains hardcoded local infrastructure and scheduling-heavy assumptions. Its useful assertions can be ported into the guarded fixtures.

## 13. Completion boundary

The cold package is complete when:

1. Both profiles are implemented and default remains held.
2. Native and browser proofs establish the behaviors above.
3. The same existing database supports the profile restart cycle without DDL.
4. V1 preflight remains compatible and v2 is explicitly opt-in.
5. Restore provenance is atomic in existing audit JSON.
6. The resulting evidence is labeled **configuration/editorial qualification**, with production promotion still pending.

**This specification does not close OWN-24/31 production acceptance.** It defines the minimum coherent editorial implementation required for those later journeys, including the SDK-specific restore and autosave protections that configuration switches alone would miss.

**Execution handoff:** Saving this plan does not start implementation. Await the separate bounded prompt after B0 integration, review and CI. Qualified active/frozen recovery remains mandatory before any production editorial-profile admission; existing v1 cutover remains held until separate operational integration; no positive pre-cutover production editorial writes are permitted. All design verification remains pending, with no new PASS claims.
