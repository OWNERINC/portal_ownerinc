# AutoCard Shell Route Design

## Problem

The AutoCard is served from the nested `/autocard/` route while the other
Portal sections are root-level pages such as `/dashboard.html` and
`/academy.html`. Shared authentication code uses relative redirects to
`./login.html` and `./dashboard.html`; from `/autocard/`, those paths resolve
inside the nested directory and can leave the user without the Portal shell.

## Decision

Make `/autocard.html` the canonical AutoCard page at the same URL depth as the
other Portal sections.

- Move the current AutoCard shell markup into `public/autocard.html`.
- Keep AutoCard-specific implementation files under `public/autocard/`.
- Update every Portal sidebar link to target `./autocard.html`.
- Turn `public/autocard/index.html` into a redirect to `../autocard.html` for
  existing bookmarks and direct visits.
- Use root-relative asset paths in the canonical page so shared auth redirects
  resolve to the existing login and dashboard pages.

This changes only navigation and document composition. AutoCard API routes,
authorization rules, editor behavior, history, uploads, and export behavior
remain unchanged.

## Acceptance Criteria

- Opening `https://portal.ownerinc.com.br/autocard.html` renders the standard
  Portal sidebar, topbar, page body, mobile menu, and logout control.
- The AutoCard sidebar item is active and has `aria-current="page"`.
- Expired or missing authentication redirects to the root `/login.html`.
- The legacy `/autocard/` URL redirects to `/autocard.html`.
- All existing AutoCard functionality continues to load from the canonical
  page.
- Static invariants cover the canonical shell, links, and legacy redirect.
- `npm run verify` and the live smoke checks pass after deployment.

## Out Of Scope

- Rebuilding the AutoCard UI.
- Moving AutoCard API routes or assets.
- Replacing the static multi-page Portal with a client-side router.
- Changing AutoCard permissions or database behavior.
