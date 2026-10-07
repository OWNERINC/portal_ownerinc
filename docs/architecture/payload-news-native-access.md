# Owner News native Payload read gate (Gate 3b1)

Gate 3b1 adds a narrow server-side boundary to native News reads before any
generic Payload administrator strategy is enabled. It does not change the
Portal login strategy, editor projection, News DTO, API/session contracts, or
the existing `canManageNews` permission contract.

## Native read policy

Every guarded request first passes the existing `canManageNews` check, which
requires the verified News permission and matching Portal UID. Only then does
the CMS resolve the current Portal `owner_news_authority` through the configured
Portal client:

| Current mode | Native News reads | Create-article view |
|---|---|---|
| `payload` | Allowed | Shown |
| `payload_frozen` | Allowed | Denied (read-only) |
| `legacy` or `frozen` | Denied | Denied |
| Invalid authority or dependency unavailable | Controlled 503 | Controlled 503 |

The sole deduplication is an in-flight authority promise in a `WeakMap` keyed by
the exact `PayloadRequest`. A later request always resolves authority again.
Unauthorized actors do not trigger authority I/O. A valid legacy/frozen state
returns a normal access denial; malformed or unavailable authority is never
treated as legacy.

The gate protects read access to `news-articles`, `news-media`,
`news-schedules`, `news-audit`, `legacy-news-revisions`,
`news-migration-runs`, and `news-migration-items`, plus `news-home`. It also
protects both native Versions stores (`news-articles` and `news-home`). The
custom schedule GET checks this policy before its transaction or document,
revision, and pending-schedule reads. The native media route independently
checks it before looking up a filename, opening a file, or processing Range.
The create-article view returns a controlled denial unless mode is exactly
`payload`; actual writes remain subject to their original write guard.

## Preserved boundaries and follow-up

- `assertCmsWriteAuthority` is unchanged: ordinary writes still require
  `payload`, acquire/recheck authority under the existing CMS lock, and
  revalidate the actor after lock acquisition. Trusted frozen preparation,
  worker, and staged-import scopes retain their existing explicit capabilities.
- The service-only `portal-news` reader and its strict News actor/check path are
  unchanged. Their trusted Local API calls continue to use explicit
  `overrideAccess: true`; this native-request gate does not wrap those calls.
- Legacy history uses the guarded collection REST read. The separate Polls view
  reads through the Portal poll proxy, whose own route requires the current
  `manageKnowledge` grant; it does not read native Payload News documents and
  does not use `owner_news_authority`.
- No built-in Payload locked-document/lock-status behavior or concurrency
  configuration is changed here. Those native admin surfaces need their own
  review before a future generic-capability admin strategy is enabled; locks
  are not disabled or weakened as part of this gate.
- This slice does not enable general CMS login or establish browser acceptance.
  Native admin acceptance remains blocked until the next gate covers every
  remaining News read, version, and media surface.
