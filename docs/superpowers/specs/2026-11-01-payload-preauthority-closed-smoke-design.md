# Payload Preauthority Closed Smoke Design

## Context

The reusable production smoke currently requires `/editorial` to return `308`
with the relative location `/editorial/admin`. That is correct after route
publication, but the disposable preauthority recovery fixture intentionally has
no public CMS route and therefore returns `404`.

Candidate run `41332091431` proved CMS liveness and the required closed
readiness state, then failed only because the generic smoke interpreted that
intentional `404` as a broken production redirect.

## Approaches Considered

1. Accept `404` in the existing redirect check. Rejected because production
   could pass with a missing editorial route.
2. Skip the editorial check in preauthority recovery. Rejected because it would
   not prove that the route remains unpublished.
3. Add an explicit, enumerated smoke mode. Selected because each environment
   retains a strict positive assertion without weakening the other.

## Design

`scripts/smoke.sh` reads `SMOKE_EDITORIAL_MODE`, defaulting to `redirect`. The
only valid values are:

- `redirect`: require status `308` and the exact relative `Location` value
  `/editorial/admin`.
- `closed`: require status `404` and require the `Location` header to be absent.

An unset variable therefore preserves all production behavior. Any other value
fails before the retry loop and before an HTTP request. Neither mode follows
redirects or reads the response body.

`recoveryFixtureEnvironment()` is the only producer that sets
`SMOKE_EDITORIAL_MODE=closed`. The preauthority command wrapper continues to
pass a stripped, explicit environment to the real smoke script; no caller can
derive the mode from mutable HTTP output or fixture state.

## Diagnostics and Failure Behavior

The existing finite `editorial_redirect` diagnostic remains the public check
identifier so report schemas and allowlists do not expand. A status mismatch is
reported as `http_status`; a wrong or unexpectedly present/absent `Location`
header is reported as `redirect`. Diagnostics retain only the numeric HTTP
status and never publish the URL, header value, or response body.

The preauthority fixture fails closed if the route redirects, returns success,
returns a status other than `404`, or emits any `Location` header. The default
profile fails closed unless it receives the exact existing redirect contract.

## Tests

Real HTTP smoke tests cover:

- default mode still accepts only `308` plus `/editorial/admin`;
- closed mode accepts only `404` with no `Location`;
- closed mode rejects redirects and `404` responses with `Location`;
- invalid modes fail without HTTP traffic;
- the full-smoke preauthority producer passes `closed` before initial seed and
  both positive restore callbacks;
- production callers that do not set the variable retain `redirect` behavior.

Guard tests pin `SMOKE_EDITORIAL_MODE=closed` to
`recoveryFixtureEnvironment()`. The recovery runbook documents both profiles.

## Non-Goals

This change does not publish the CMS route, activate CMS, install the native
protocol, alter readiness, enable workers or scheduling, perform restore on
production, deploy, transition authority, or execute cutover.
