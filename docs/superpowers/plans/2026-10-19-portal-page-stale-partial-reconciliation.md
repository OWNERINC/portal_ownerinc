# Portal Page Stale Partial Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a proven stale upload owner cannot leave an interrupted chunk `.part` stranded when cleanup or another operation takes over first.

**Architecture:** Preserve a durable exact per-upload recovery marker by hard-linking the process-identity-proven stale lock before removing its canonical lock path. While holding the new filesystem owner, reconcile only manifest-declared per-index part paths (and the assembly scratch only in `receiving`/`assembling` states), preserving completed chunk files and any assembled recovery file in `ready_to_rename`/`renamed`. Clear the marker only after successful bounded reconciliation; retries recognize it if filesystem validation/removal fails.

**Tech Stack:** Node 24, TypeScript, Payload 3.90.2, Node filesystem APIs, Node test runner, existing deterministic Payload transaction fixture.

## Global Constraints

- Preserve canonical lock order `CMS_REFERENCE_LOCK` → per-upload advisory lock → filesystem ownership.
- Never enumerate `.incoming`; touch only exact server-derived filenames.
- Validate expected paths with `lstat`-based regular-file/no-symlink checks before removal.
- Chunk partials are not completed chunks; never remove canonical `.chunk` files, manifests, or final media during stale-partial reconciliation.
- Preserve `open('wx')`; ordinary exclusive-create collisions remain untouched unless a durable stale-recovery marker authorizes exact partial reconciliation.
- A failed reconciliation retains its marker and leaves the upload eligible for bounded cleanup retry.
- Do not modify `node_modules`, database schema, Owner News, deployment files, or running services.
- Keep the ignored Task 3 report unstaged.

---

## File Structure

### Modify

- `cms/src/portal-pages/upload-service.ts` — stale-owner recovery marker, bounded manifest-derived partial reconciliation, and calls from cleanup/chunk/complete/cancel.
- `cms/tests/unit/service/portal-page-uploads-lifecycle.test.ts` — the three requested crash/retry regressions plus recovery-marker failure and unrelated symlink checks.
- `docs/architecture/portal-pages-content.md` — document stale partial recovery and evidence retention.
- `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-3-report.md` — ignored/local round-four RED/GREEN and verification evidence only.

## Task 1: Reproduce stranded partials

- [x] Add a test helper that writes a valid lock record for a process identity proven stale by the OS, then creates exact `<id>-<index>.part` fixture bytes.
- [x] Add regression 1: after a crash leaves stale lock plus index-0 partial, unexpired cleanup removes the partial, preserves manifest/chunks/final, reschedules the queue, and a retry of index 0 succeeds.
- [x] Add regression 2: with a two-chunk manifest and stale index-0 partial, send index 1 first; then retry index 0 successfully and assert index 1's canonical `.chunk` survived.
- [x] Run the two tests and record the current failure: first recovery path leaves the `.part`, making retry fail at exclusive `wx`.

## Task 2: Preserve and consume recovery evidence safely

- [x] Add `recoveryMarkerPath(paths,id)` with exact `r-${id}.lock` naming. When `readLockOwner` proves the canonical `u-${id}.lock` stale, hard-link it to the recovery marker before unlinking the original; never create a marker for the lock-publication temp path.
- [x] On later acquisitions, validate an existing exact marker as a regular private lock record and require its recorded process identity to remain stale. Set `UploadLock.recoveredStaleOwner` when either a newly reclaimed canonical lock or marker establishes pending recovery.
- [x] Implement `reconcileStaleManifestPartials(paths,manifest,ownership)`: require a validated UUID and `chunkCount` 1–100; for each exact declared `chunkPartPath`, use `assertRegularOrAbsent` then `removeRegularFile`; also remove exact incomplete `manifestTempPath`; remove `assembledPartPath` only in `receiving`/`assembling`; preserve `.chunk`, manifest, final bytes, and assembled data in `ready_to_rename`/`renamed`.
- [x] Sync `.incoming` and remove the marker only after every check/removal succeeds. If any operation fails, leave the marker in place; release the active owner normally so the next cleanup/operation can reacquire and retry.
- [x] Run the two red regressions and assert both now pass without weakening exclusive `wx` behavior.

## Task 3: Wire all first-reclaimer paths and failure isolation

- [x] In `putChunk` Phase A, after media/manifest validation and filesystem ownership, run stale-partial reconciliation before releasing the short transaction. If it fails, release the acquired filesystem owner and let the transaction roll back while retaining the marker.
- [x] In `reconcileQueuedUpload`, reconcile after loading a valid manifest and before unexpired receiving/assembling rescheduling. For no-manifest recovery, clear the marker only after exact existing unmanifested-artifact cleanup succeeds.
- [x] In init, `complete`, and `cancel`, invoke the same helper when the acquired lock reports pending stale recovery; do not duplicate partial-deletion logic.
- [x] Add failure regression: a symlink/non-regular expected index `.part` fails closed, leaves the durable marker and unrelated data, and a later safe replacement plus cleanup retries reconciliation.
- [x] Add regression 3: unrelated `.part` files and unrelated symlink/junction `.part` entries remain untouched; expected symlink paths are never followed or unlinked.
- [x] Run the lifecycle test file and the focused upload/adapter/confirmation suite.

## Task 4: Documentation, verification, and commit

- [x] Update `docs/architecture/portal-pages-content.md` to explain manifest-bounded stale partial cleanup, the durable marker, retry behavior, and preserved completed chunks/final state.
- [x] Append round-four RED/GREEN evidence to the ignored Task 3 report, including exact requested scenario results and the platform symlink limitation if applicable.
- [x] Run the focused upload suite, `npm run typecheck:cms`, `npm run test:cms`, `$env:PAYLOAD_TEST_EXTERNAL_PARENT='C:\Windows\Temp'; npm run verify`, and `git diff --check`.
- [x] Review staged files; leave the ignored report unstaged; commit the bounded correction.
- [x] Confirm clean tracked status and report commit, tests, residual risk, and report path.
