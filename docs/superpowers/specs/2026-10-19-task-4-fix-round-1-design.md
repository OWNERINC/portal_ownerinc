# Task 4 fix round 1 — approved design

## Goal and scope

Close the six review findings against the Task 4 read bridge without broadening
Owner News, changing page publication behavior, weakening the Payload preview
path guard, or starting Docker/services. Keep the fixes at the existing API DTO,
API asset-client, CMS asset-endpoint, and test boundaries. Append exact evidence
to the ignored Task 4 report and deliver the fixes in one focused commit.

## DTO contract

Audit the current Task 1 `PortalPageDTO`, `PortalPageBlock`, and nested inline
contracts against both CMS projection/normalization and the API validator. Fix
the exact-key helper so the type-specific optional keys are accepted by the
initial discriminator check and remain validated by their existing field
validators. Keep `layout` optional on every block; image `caption`, each gallery
image `caption`, and callout `title` are the other optional content fields. Cover
and category members have no optional keys; nullable `cover` and
`published_at` are required DTO properties. Preserve rejection of every unknown
key.

Add a cross-boundary regression which feeds real `projectPortalPageContent()`
outputs through the real API `readPortalPageResult()` validator. Include all ten
block discriminators, all five layouts, and each optional field; test unknown
keys at block, gallery image, cover, and category boundaries.

## Asset lifecycle and errors

In `createPortalPagesClient().asset()`, distinguish output state (open, closed,
errored, or cancelled) from a single idempotent cleanup operation. Cleanup must
cancel the upstream reader/body where appropriate, abort the fetch controller,
clear the active idle timer and external-signal listeners, and settle once. The
normal EOF path verifies exact byte count, closes downstream, and cleans up
without aborting an already-finished transfer. Every error/cancel/abort path uses
the same cleanup owner without using an output terminal flag to skip resource
cleanup.

Before validating success-stream headers, recognize only bounded, exact CMS JSON
errors for asset 403 (`{"error":"forbidden"}`) and 404
(`{"error":"not_found"}`). Map those to safe API 403/404 errors. Any other
status, content type, body shape, size, or malformed error body becomes safe 503;
never forward CMS text. Cancel or consume/cancel every error body within a small
fixed bound.

## CMS ownership and integration

Retain the opened `PortalPageAssetResponse` outside the `withCmsTransaction`
callback. Handoff ownership only after the transaction resolves and the HTTP
`Response` has been successfully constructed. A `finally` cancels the retained
body if either transaction completion or response construction fails before
handoff. The media body remains responsible for closing its descriptor exactly
once on EOF, consumer cancel, or request abort.

Test the actual CMS asset endpoint for transaction/commit failure after open,
unreferenced asset and wrong-role MIME denial before descriptor open, normal
handoff, and abort. Extend published-version fixtures so their input is not
pre-sorted, assert the `updatedAt DESC, id DESC` query, and exercise publish A →
newer publish B → stale A asset denied/current B asset accepted. Connect the real
API client to the real CMS endpoint handler and Express contents router for safe
error propagation rather than returning synthetic API-client exceptions.

## Verification and delivery

Use the approved temp parent only if the full ancestor walk accepts it. The
existing guard rejects the profile temp because it finds `.git` in an ancestor;
do not change this guard or its tests. A candidate alternate parent must pass the
real `validateExternalRoot()` check for this checkout and be writable before the
root suite runs. Execute focused API/News tests, CMS typecheck/syntax, the full
CMS suite, and root `npm run verify` with Docker unavailable. Record commands,
counts, any skips, environment constraints, review notes, and exact commit in
`task-4-report.md`, leaving that report ignored and uncommitted.
