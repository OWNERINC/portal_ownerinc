# Payload native admin entry (Gate 3b2)

Gate 3b2 adds a bounded general Portal-admin entry to the existing Payload 3.90.2
runtime. It is an integration boundary, not acceptance that Academy, Benefits,
Reminders, or other domain writes have moved into Payload. Their supported editing
surface remains the central CMS until a separate integration is approved.

## Session and identity boundary

- `/api/cms/v2/session` is the existing Portal v2 session contract. CMS resolves
  its cookie through the private `/api/internal/editorial/admin/session/resolve`
  route on every Payload request. The v2 actor is exactly
  `{ version: 2, uid, email, name, capabilities }`; `capabilities` contains only
  the four fixed boolean grants `manageKnowledge`, `manageAcademy`,
  `manageBenefits`, and `manageReminders`. Unknown keys, non-booleans, an empty
  capability set, mismatched UID, invalid expiry, and dependency failure fail
  closed.
- The existing strict News resolver remains first in the Payload auth strategy
  list. A News actor therefore retains its original DTO and request path. If that
  resolver denies a general-only actor, the separate v2 strategy may authenticate
  the same shared-cookie/session-store record; `adminActor` and its expiry are
  request-only properties, never `PortalEditors` fields.
- `portal-editors` grants general Payload admin access only to a verified v1 News
  actor or a valid v2 actor with at least one current capability. Its `read`
  access is still an ID filter for the current projected Portal identity. Payload
  preferences continue to use Payload's generated user-id plus collection filter,
  and the generated `user` hook replaces submitted ownership with the current
  request identity. Preferences are not shared across different Portal projections.
- The CMS hub exposes the additive native-admin button only after v2 availability
  confirms both runtime readiness and a current admin capability. Clicking it
  repeats availability, issues a v2 session with the existing Firebase session,
  checks the exact returned actor/UID/expiry, then navigates to `/editorial/admin`.
  Owner News's existing v1 entry button and availability rules are unchanged.
  Payload's in-admin session watcher resolves v2; logout still revokes through the
  shared v1 DELETE route and common Portal session store. The Payload `/me` hook
  reattaches only that request's verified actor to the in-memory UI user, allowing
  the custom Enquetes navigation item to be hidden unless `manageKnowledge` is
  current; the actor is not written to the projection.
- The built-in account avatar uses Payload's local `default` icon rather than
  Gravatar, preserving the CMS image-CSP and preview network boundary.

## News read and write distinction

The News native read gate accepts either the strict v1 News actor or a verified v2
actor whose current `manageKnowledge` capability is `true` and whose UID matches
the projected identity. It then resolves current `owner_news_authority` using the
existing request-keyed in-flight-only fence: `payload` and `payload_frozen` permit
native reads; `legacy`, `frozen`, invalid authority, or an unavailable Portal
dependency do not.

This does **not** make a v2 actor a News writer. Native collection/global
create/update/delete, the article-creation view, schedule mutations, the trusted
legacy import helper, and the post-lock write-authority path still require the
strict v1 `portalActor`; writes continue to recheck current authority and
`checkPortalActor` after the CMS transaction lock. Worker/import capabilities and
the News service DTO are unchanged. A read-capable generic actor therefore cannot
save drafts, publish, change News history/media, or write schedules.

## Built-in lock and preference review

The generic strategy is enabled only with an explicit request-scoped policy for
Payload's generated `payload-locked-documents` collection. We reviewed the pinned
Payload **3.90.2** installed sources:

- `payload/dist/locked-documents/config.js` generates document/global lock fields
  and sets all four collection operations to `defaultAccess` (any logged-in user).
  Its `user` relationship can resolve the authenticated Portal editor identity.
- `@payloadcms/ui/dist/utilities/getGlobalData.js` queries global locks at depth 1
  with `overrideAccess: false`, selecting `globalSlug`, `updatedAt`, and `user`.
  `@payloadcms/next/dist/views/Dashboard/index.js` performs that query before it
  renders even a custom dashboard component. The same lock collection is queried
  for collection/global document lock status with `overrideAccess: false`.
- `payload/dist/auth/getAccessResults.js` calculates collection/global UI
  permissions through each collection's access functions. In Payload's pinned
  initializer (`payload/dist/index.js`), `payload.collections[slug].config` points
  at the same config object held in `payload.config.collections`; the supported
  `onInit` config hook runs before request handling.
- `payload/dist/preferences/config.js` already scopes read/update/delete by both
  `user.value === req.user.id` and `user.relationTo === req.user.collection`, and
  its `user` before-validate hook overwrites the submitted owner with the current
  request user.

The CMS `onInit` hook fail-closes if that generated lock collection/config shape is
missing or has changed. It replaces only its `create/read/update/delete` access
functions. The original Payload lock behavior remains available to a verified v1
News actor while current authority is `payload` or `payload_frozen`. A v2-only
actor—including one with `manageKnowledge` but without the strict v1 News actor—
cannot list, inspect, create, update, or delete News lock rows, so neither dashboard
global-lock data nor native document lock metadata reveals an editor identity.
This does not disable document locks, alter lock duration/concurrency, or grant any
News document mutation. Preferences use their stock generated policy unchanged.

`AdminHome` uses Payload's native `Gutter` and standard heading elements, contains
no News document query/prefetch, and states that unintegrated areas remain in the
central CMS. Payload's surrounding dashboard still invokes its built-in global-lock
query; that query is covered by the scoped access policy above. Native collection
and global navigation continue to be derived from Payload's per-request
`getAccessResults` permissions. The custom Enquetes link is shown only for the
request actor's `manageKnowledge` grant; the Portal poll endpoint keeps its existing
strict News session contract.

## Verification boundary

Focused unit tests exercise the v2 contract/client/strategy, fallback order,
read/write separation, Payload 3.90.2 generated lock/preference policies and
`getAccessResults`, generic hub entry, and both v1/v2 browser session-watch paths.
These tests do not establish real browser sign-in, cookie attributes, database
filter execution, cross-tab behavior in a browser, or lock concurrency against a
live Payload runtime. The protected HTTPS preview was not rebuilt or modified for
Gate 3b2; its previous image does not contain this code. Native browser acceptance
and runtime application remain a separate reviewed step.
