# Task 4 Review-Fix Round 2 Design

## Goal

Close the remaining Task 4 browser-acceptance gaps with executable assertions,
fixture isolation, and explicit browser evidence for historical previews and
editorial-session revocation.

## Design

The browser controls module will own small exported boolean-backed equality,
inequality, and regular-expression assertion helpers. Its acceptance paths will
use those helpers instead of undeclared Node assert methods, and focused unit
tests will execute both successful and failing helper paths.

Native acceptance will create a second synthetic Portal Page solely for block
insertion/reordering and put its ID in the private browser handoff. The browser
runner will open it in a separate page and pass that page only to the structural
control case. An orchestration helper will snapshot the main editor's original
image/gallery/video/PDF upload positions before controls, verify the same
positions afterward, and pass that snapshot to the upload suite. A unit test
will use fake page/runner dependencies to prove the upload suite receives the
unchanged map.

After control/upload and News smoke cases, the browser runner will create an
exact saved-Version preview, save and publish a newer Version, then reload the
original URL and verify the old summary, Version-qualified PDF URL, and Range
bytes still belong to the old preview. As its final browser case, the runner
will revoke that synthetic cookie using the disposable authority's real
`/api/internal/editorial/session/revoke` HTTP contract. The browser will then
make a fresh same-origin Range request with the still-present cookie and require
401/403 with no media bytes. The local authority fixture will track revoked
cookies and reject subsequent V2 resolutions; it remains test-only and makes
no claim about a live Portal service.

All cases are explicit in `expectedBrowserAcceptanceCases`. Setup/unavailable
conditions stay named `NOT_EXECUTED`; missing or non-PASS required cases cannot
aggregate to overall `PASS`. The acceptance report will distinguish offline
regression evidence from unexecuted real database/manual checks.

## Error and isolation behavior

The source upload fixture is never structurally mutated. If its positional
snapshot changes or cannot be read, upload cases are recorded `NOT_EXECUTED`,
while the position invariant itself fails; the overall result cannot pass.
Session revocation runs last, after every other browser suite, so its deliberate
authorization change cannot contaminate earlier cases.

## Verification

Run the focused browser-helper/orchestration/registry tests, all Task 4 unit
tests, CMS typecheck, `node --check` for the browser runner and modified MJS
helpers, the full CMS unit suite, and `git diff --check`. Real browser/database
acceptance remains `NOT_EXECUTED` unless the existing disposable fixture and
external Playwright module are explicitly provided.
