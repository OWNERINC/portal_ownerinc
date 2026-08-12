# AutoCard Media Audit Design

## Problem

AutoCard media uploads are stored behind the authenticated
`/api/autocard/media/:id` route. The editor currently places that API URL
directly in image elements. Browsers do not attach the Firebase Bearer token to
`img.src`, so uploaded photos return `401 Authentication required` and do not
appear. The same issue affects cards reopened from history, and the birthday
variant can render a broken image while an authenticated media fetch is still
pending.

## Decision

Keep AutoCard media private and load it through the shared authenticated API
client.

- Add an authenticated asset helper in `public/js/auth.js` that returns a
  browser `blob:` URL for successful binary responses.
- Use that helper in `public/autocard/app.js` for newly uploaded media and media
  restored from card history.
- Revoke replaced/stale blob URLs and release the current URL on page hide.
- Render image-bearing variants only when a loaded media URL exists; otherwise
  keep the existing placeholder/icon state.
- Keep the AutoCard API media route authenticated and keep its existing shared
  authorization and storage behavior.
- Review and test create, upload, save, history, edit, duplicate, delete,
  variants, responsive rendering, and PNG export without changing the editor's
  public behavior or API contracts.

## Acceptance Criteria

- An authorized DHO user uploads a valid image and sees it in the editor.
- A saved card with media displays its image when reopened from history.
- Birthday, event, employee, and generic media variants do not emit a broken
  image while media is loading or when media is unavailable.
- The media endpoint remains inaccessible without authentication.
- Blob URLs are not accumulated when the user changes cards or media.
- Save, edit, duplicate, delete, filters, variants, responsive layout, and PNG
  export continue to work.
- Static invariants cover the authenticated binary helper, private media route,
  media loading path, cleanup, and the birthday loading guard.
- `npm run verify` and live deployment checks pass.

## Out Of Scope

- Making uploaded media public.
- Replacing Firebase Auth or the PostgreSQL AutoCard schema.
- Rebuilding the AutoCard visual design.
- Adding a frontend framework, router, or new storage service.
