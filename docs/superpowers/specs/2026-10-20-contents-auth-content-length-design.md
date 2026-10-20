# Contents opt-in auth body length precheck

Date: 2026-10-20. Status: approved for implementation.

## Goal and scope

Close the remaining Task 2 transport issue by applying the same advertised
`Content-Length` validation to the opt-in authentication-error decoder used by
Contents on 401/403 responses. Preserve the existing default authentication
callers, API behavior, session classification, and ownership of the original
response body.

## Design

- Extract the canonical nonnegative decimal/safe-integer/cap check used by the
  Contents JSON reader into a small browser module shared by `auth.js` and the
  Contents API. A missing header is accepted; malformed, comma-combined,
  negative, noncanonical, unsafe, or over-cap values are rejected before any
  read. The parser reports absent, valid, or rejected-with-reason.
- The opt-in auth decoder checks the cloned response headers before acquiring a
  reader. Native `Response.clone()` may schedule a tee prefetch as the clone is
  created; rejection must cause no additional source pulls or clone-reader
  reads. It cancels only the cloned body branch exactly once and does not await
  the tee cancellation promise: awaiting one branch can deadlock while the
  original branch is still owned by the caller. The normal auth path remains
  responsible for the original branch.
- For absent or accepted headers, keep the existing streaming read and actual
  byte-count cap. This catches absent and understated lengths. The default auth
  path (`bodyLimit === null`) continues using its existing `clone().json()` path.

## Validation

Use real `Response.clone()` streams in auth tests. Verify valid, absent,
understated, oversized, malformed, duplicate, negative, and unsafe headers;
record the source-pull baseline at native clone setup and verify rejection adds
no pulls/reads; read or cancel the original branch under caller ownership; and
prove tee cancellation settles without a hang. Include a fatal 401 case to
verify normal auth cancellation and confirm server body text does not enter the
thrown error. Keep Contents API status sanitization tests.

Run focused auth/Contents API/routing tests, an explicit Node 18-compatible
syntax probe for changed shared code, the full public suite with test concurrency
bounded, generated-shell check, security checks, and `git diff --check`. Do not
start services or change server behavior.
