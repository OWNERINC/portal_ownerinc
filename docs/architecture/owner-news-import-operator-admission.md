# Owner News frozen import operator admission — Gate 4 Unit 1A

## Scope and status

This change adds a server-local admission primitive for the existing transactional
`applyNewsImport` implementation. It is not an operator CLI, HTTP endpoint, browser
activation, production integration, readiness signal, release approval, or
certification. `assertImportApplyReady` remains unconditionally closed, so the
existing public `--apply` CLI path still returns `import_apply_not_ready`.

The primitive is exported from `cms/src/migration/operator-admission.ts` for a
future explicitly reviewed server-side caller. Nothing in this slice registers or
invokes it from a route, scheduled job, Payload endpoint, or standalone script.
The caller must already hold the live Payload runtime created with the separate
ID-preserving import adapter configuration.

## Admission contract

`applyFrozenNewsImport` requires an explicit actor UID, run UUID, manifest SHA-256,
expected authority epoch, the exact in-process result returned by
`runImportPreflight`, and the Payload runtime. The preflight result is bound in a
private `WeakMap` to its validated loaded bundle, target URL, physical target
identity, canonical target upload root, source fingerprint, and frozen epoch. A
serialized/reconstructed result is not admissible, and a preflight result can be
claimed once. Its private bundle, URL, and path are not added to CLI/report output.

Before creating or projecting a CMS editor identity, admission checks:

1. The requested actor, run, manifest, and epoch match the preflight/bundle
   identity; the bundle itself records the same frozen source authority and
   source instance.
2. The live Payload adapter's configured `poolOptions.connectionString` matches
   `CMS_DATABASE_URL`, its endpoint/database matches the preflight destination,
   and a read-only physical identity query through that adapter's own pool matches
   the preflight PostgreSQL system identifier plus database OID.
3. `CMS_UPLOAD_DIR`, the configured `news-media.upload.staticDir`, and the
   preflight target upload root resolve to the same existing private real path.
   Symlinks, checkout/public paths, missing roots, and mismatches fail closed.
4. The Portal service's strict `checkPortalActor` response has the exact requested
   UID and current News-management permission, and current Portal authority is
   exactly `frozen` at the expected epoch.

Only then does the server reuse the existing idempotent Portal editor projection
routine, construct a real Payload request with `createLocalReq`, and enter the
existing import transaction. The transaction request rechecks target provenance
and physical database identity before import writes. Existing
`assertFrozenPreparationActor` checks run after lock 7194030; bootstrap and
preparation hooks continue to recheck frozen authority, actor, run, and transaction
identity. The run UUID is explicit and must match an existing row for the manifest
or be the UUID used for its first bootstrap.

The operator capability is private, request-scoped, and held only in process-local
`WeakMap`s. It is bound to the exact request, projected strict News actor, Payload
runtime, live adapter session, loaded bundle object, run UUID, manifest, and epoch;
it is removed when the admitted operation settles. It is not an HTTP/context flag,
serialized token, native Payload session, or general `canWriteNews` exemption.
Ordinary native News mutation guards still require their original strict actor and
current `payload` authority. The existing preparation capability—not the operator
admission marker—continues to authorize the tightly scoped frozen import writes.

## Verification boundary and remaining work

The added tests use Portal/adapter contract doubles and private temporary
directories. They verify fail-closed identity, authority, target, storage, request,
transaction, and capability boundaries; they do not execute a real database,
import transaction, CMS runtime, or production environment. The CMS database role
must be able to read `pg_control_system()` for the live physical identity check; if
it cannot, admission intentionally fails closed until a separately approved
identity mechanism is supplied.

No Task15 importer workflow, durable operator launcher, integration adapter,
coverage/drain proof, native CRUD acceptance, schedule activation, reconciliation
acceptance, release admission, or production validation is established here.
Those remain separate gated work. Independent review of this implementation and
the next explicit integration decision are still required.
