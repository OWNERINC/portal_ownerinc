# Payload admin entry contract (Gate 3a)

Gate 3a adds a versioned Portal session contract that can admit administrators
from any of the four fixed Portal capabilities. It does not change
Payload's native authentication strategy, collections, access rules, frontend,
or News read bridge. No CMS UI should consume this contract until a later gate
protects every native News read surface, version, and media path against the
current News authority.

## Public Portal API

All routes are mounted under `/api/cms/v2/session`. Requests are non-cacheable.
Availability and issuance authenticate a Firebase ID token through the normal
Portal middleware and require a verified, active Portal profile. Public
mutations require the exact configured `Origin`; cross-site fetches are denied.
Issuance, session resolution, and revocation also require the existing Payload
bridge secret and the existing secure editorial-cookie configuration. The
versioned API uses the same HTTP-only editorial cookie as News v1.

| Method and path | Contract |
|---|---|
| `GET /availability` | Authenticated runtime/admin-entry check; this read does not require the optional bridge secret or cookie configuration. |
| `POST /` | Issue/rotate the shared editorial cookie after authorization and a successful Payload runtime probe. Returns `201` with `{ actor, expiresAt }`. |
| `GET /` | Resolve the shared cookie against current Firebase and Portal state. Returns `{ actor, expiresAt }`. |
| `DELETE /` | Revoke the shared cookie and clear it; exact Origin required. Returns `204`. |

Availability has the fixed response shape:

```json
{
  "version": 2,
  "adminEntryAllowed": true,
  "runtimeAvailable": true,
  "canEnterAdmin": true
}
```

`canEnterAdmin` reflects the current Portal profile. `runtimeAvailable` is the
existing bounded `/editorial/ready` probe (2-second maximum, 256-byte response
body), and `adminEntryAllowed` is their conjunction. No `owner_news_authority`
query or activation state participates. An active authenticated Portal user
without an allowed capability receives the same response with
`canEnterAdmin: false`; availability does not grant a session.

The v2 actor is a server-derived, versioned DTO. Its exact shape is:

```json
{
  "version": 2,
  "uid": "portal-user-uid",
  "email": "editor@example.test",
  "name": "Editor",
  "capabilities": {
    "manageKnowledge": false,
    "manageAcademy": true,
    "manageBenefits": false,
    "manageReminders": false
  }
}
```

The capability object always contains exactly those four booleans, in the
canonical order shown. Each value is computed with the existing `can(user,
permission)` policy; the shell is allowed when at least one is true. A role by
itself, `manageUsers`, arbitrary permission keys, request-body actors, and
client-supplied capabilities never grant access. The DTO does not claim that
any individual Payload collection or API area is authorized by these flags.

## Internal Portal resolver

Payload-side service callers resolve the general actor through the separately
scoped endpoint:

```text
POST /api/internal/editorial/admin/session/resolve
Authorization: Bearer <PAYLOAD_TO_PORTAL_SECRET>
Content-Type: application/json

{"cookie":"<editorial cookie value>"}
```

The JSON body must contain only the non-empty `cookie` string. Success returns
`{ "actor": <v2 actor>, "expiresAt": "..." }`. The service secret, 16 KiB
body cap, sanitized errors, and process-wide quotas remain enforced by the
existing internal router. This resolver deliberately shares its fixed `resolve`
quota lane with News session resolution and the authenticated poll-admin proxy:
the aggregate budget is 3,000 requests per 60-second window per API process. It
does not add a worker actor-check endpoint or query News authority.

## Session and News compatibility

The two contracts share the existing SHA-256-only session store, cookie name,
two-hour expiry, serialized issuance/rotation transaction, and revocation. No
second session table or independent cookie audience is introduced. Every
resolution verifies the Firebase session cookie (including revocation), then
reloads the verified active Portal profile and calculates current capabilities.
Permission changes therefore apply immediately. This is a current-grant model,
not a grant snapshot or audience token: a v2 cookie with only `manageAcademy`
fails the unchanged News v1 `manageKnowledge` check; if its current profile
later gains `manageKnowledge`, v1 may resolve that same cookie.

News v1 continues to expose its existing `{ uid, expiresAt }` public session
response and strict internal actor DTO `{ uid, email, name, canManageNews: true
}`. `actorFromUser`, `checkEditorialActor`, the News worker contract, and
`owner_news_authority` semantics remain News-specific. General capabilities
must not be projected into News's `canManageNews` field.

## Implementation boundary

- `api/editorial-session/service.js` shares only the identity/session lifecycle;
  fixed v1 and v2 wrappers own their authorization projections.
- `api/editorial-session/admin-actor.js` owns the four-capability allowlist and
  the strict v2 actor construction.
- `api/routes/editorial-admin-session.js` owns the public v2 lifecycle and the
  independent readiness availability response.
- `api/routes/editorial-internal.js` owns the strict internal v2 resolver path.
- `tests/unit/editorial-admin-session.test.mjs` covers HTTP authorization,
  readiness/transaction ordering, current grants, cross-resolution, revocation,
  strict internal input, and News isolation without external services.

This is an API contract only. Gate 3b must establish News authority checks for
all native Payload News reads, drafts/versions, and media before any native CMS
frontend links or relies on the general v2 admin actor.
