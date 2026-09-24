# Persistent Portal Navigation Implementation Plan

**Goal:** Same-document area navigation with stable permission-driven UI.

**Architecture:** A small native router preserves the existing shell and mounts
existing page modules explicitly. Shared authentication retains a same-account
visual snapshot during revalidation while every API request stays authenticated.

**Tech Stack:** Existing HTML/CSS/ES modules, Firebase and Express APIs.

## Constraints

- Preserve all existing uncommitted Owner News and PDF work.
- No commits, production deployment, iframe shell, global event API patching or
  cache-busting module imports. No new framework.
- Existing API contracts and URLs remain compatible.
- Each page owns lifecycle cleanup; stale work cannot touch a later page.

## Task 1 — Authentication stability

Own `public/js/auth.js`, `public/js/auth-shell.js`, permission selectors in
`public/css/layout.css` only, and focused tests. Preserve exported helper
signatures. Deduplicate concurrent profile validation; bind cache to account UID.
Distinguish transient failures from definitive denial, retaining only visual
navigation state in the former. Remove expired-cache-induced menu jumps while
never treating a snapshot as authorization. Invalidate on logout/account change.

## Task 2 — Router and page lifecycle

Own new router/lifecycle module, `public/js/sidebar.js`, shell generator, page
entry scripts, HTML and focused lifecycle tests. Keep `.sidebar`, `.topbar` and
outer `.main-content` nodes stable. Fetch HTML, prepare styles, mount page body
and dialogs with explicit init/dispose functions and cached module imports.
Handle internal navigation, history, cancellation, focus and scroll; do not
intercept page-local filter history or modified/download/external links.
Cover all actual sidebar destinations including both card tools. Refactor
page-level global listeners/timers/async work to lifecycle-aware equivalents.
Make Admin tabs stable and activate before unrelated feature-discovery calls.
Preserve unsaved editing guards for click and history navigation.

## Task 3 — Review and validation

Fresh review of actual changes and tests; resolve security or data-loss defects.
Run `npm run verify`, `git diff --check`, authenticated browser navigation loops
and assert unchanged document/sidebar identity. Verify mobile, unsaved CMS,
loading/denial and no duplicate handlers after repeated routes. Update product
and architecture documentation with actual behavior and evidence.
