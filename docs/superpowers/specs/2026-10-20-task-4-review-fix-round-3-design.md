# Task 4 Review-Fix Round 3 Design

## Goal

Restore the original Portal Page editor before validating upload destinations,
and ensure historical-preview acceptance selects only the always-visible PDF
link rather than the nested `<object>` fallback.

## Design

The browser orchestration captures `page.url()` before the controls suite. It
runs controls in `try/finally`; the `finally` navigates the original editor page
back to that URL and waits for the native **Salvar versão** control and each
exact image, gallery, video, and PDF wrapper to be visible. Only after that
restoration/readiness barrier does orchestration take the post-controls position
snapshot. The existing equality gate still decides whether the upload runner is
called. If controls or restoration fail, `finally` attempts restoration and the
error propagates; uploads are not started.

The historical-preview flow uses one helper selecting
`.portal-page-preview__pdf > a` before and after reload. Since the fallback link
is nested beneath `<object>`/`<p>`, it cannot match this direct-child selector.
An offline source/locator regression checks the helper uses the direct-child
selector at both checkpoints and rejects the broad descendant selector.

## Isolation and invariants

The synthetic structural Page, required browser case order, and test-only
stateful revocation semantics are unchanged. Browser/database acceptance stays
`NOT_EXECUTED` without the disposable fixture and external Playwright setup.

## Verification

Run the focused browser harness tests, all `portal-page-*` Task 4 unit tests,
CMS typecheck and complete CMS unit suite, syntax checks for the editorial MJS
modules, and `git diff --check`. Do not start a browser or database fixture in
this offline verification pass.
