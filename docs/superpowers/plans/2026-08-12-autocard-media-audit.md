# AutoCard Media Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make private AutoCard photos load reliably after upload and from history while auditing the editor's core operations for regressions.

**Architecture:** Extend the shared Firebase-authenticated request path with a binary asset helper that returns a temporary `blob:` URL. AutoCard will load media through that helper, manage replacement/cleanup and stale async responses, and keep its existing editor/API contract and private media route.

**Tech Stack:** Static HTML, vanilla JavaScript modules, Firebase Auth, Express, PostgreSQL, Node.js built-in test runner, existing Nginx and `npm run verify` checks.

## Global Constraints

- Keep AutoCard media private and require authentication for `/api/autocard/media/:id`.
- Do not add a frontend framework, router, storage service, or dependency.
- Keep AutoCard API routes, authorization rules, schema, editor controls, and public behavior unchanged.
- Revoke replaced/stale blob URLs and release the current URL on page hide.
- Preserve upload, save, history, edit, duplicate, delete, filters, variants, responsive rendering, and PNG export.

---

### Task 1: Add authenticated binary asset support

**Files:**
- Modify: `public/js/auth.js:29-62`
- Modify: `tests/unit/autocard-invariants.test.mjs:21-90`

**Interfaces:**
- Consumes the existing authenticated `requestAPI` behavior and Firebase `auth` instance.
- Produces `fetchAPIAsset(path, options = {})`, returning a browser `blob:` URL after an authenticated binary response succeeds.

- [ ] **Step 1: Add failing static assertions**

Extend the AutoCard invariants to require:

```js
assert.match(auth, /export async function fetchAPIAsset\(/);
assert.match(auth, /await response\.blob\(\)/);
assert.match(auth, /URL\.createObjectURL\(blob\)/);
assert.match(app, /fetchAPIAsset/);
```

Also assert that the backend media route remains behind the shared AutoCard middleware:

```js
assert.match(route, /router\.use\(authMiddleware, requireAutoCard\)/);
assert.match(route, /router\.get\('\/media\/:id'/);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: FAIL because `fetchAPIAsset` does not exist and the app does not import it.

- [ ] **Step 3: Refactor shared authentication into one request path**

In `public/js/auth.js`, keep one authenticated fetch implementation that:

1. waits for `auth.authStateReady()`;
2. throws `APIError('Sessão encerrada.', 401)` without a current user;
3. gets the Firebase ID token;
4. preserves caller headers and only adds JSON `Content-Type` for string bodies;
5. adds `Authorization: Bearer <token>`;
6. returns the native `Response`.

Use that path for both `requestAPI` and:

```js
export async function fetchAPIAsset(path, options = {}) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const requestId = body.requestId ? ` (referência ${body.requestId})` : '';
    throw new APIError(`${body.error || `A solicitação falhou (${response.status}).`}${requestId}`, response.status);
  }
  return URL.createObjectURL(await response.blob());
}
```

Do not add a default JSON content type to binary requests.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the authenticated asset helper**

```sh
git add public/js/auth.js tests/unit/autocard-invariants.test.mjs
git commit -m "feat: add authenticated asset requests"
```

### Task 2: Load and clean up AutoCard media safely

**Files:**
- Modify: `public/autocard/app.js:1-40`
- Modify: `tests/unit/autocard-invariants.test.mjs:39-100`
- Modify: `CHANGELOG.md:12-24`

**Interfaces:**
- Consumes `fetchAPIAsset` from `public/js/auth.js`.
- Produces a media lifecycle in AutoCard where `current.mediaUrl` is only a loaded `blob:` URL or null.

- [ ] **Step 1: Add failing media lifecycle assertions**

Assert that `public/autocard/app.js` contains:

```js
assert.match(app, /import \{ fetchAPI, fetchAPIAsset \} from '\.\.\/js\/auth\.js'/);
assert.match(app, /URL\.revokeObjectURL/);
assert.match(app, /pagehide/);
assert.match(app, /fetchAPIAsset\(`/);
assert.match(app, /mediaUrl: null/);
```

Assert that media-bearing rendering guards against an absent URL rather than creating a broken protected URL:

```js
assert.match(app, /current\.mediaUrl\s*\?/);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: FAIL because the app still imports only `fetchAPI` and directly stores protected API URLs.

- [ ] **Step 3: Implement media lifecycle and stale-response protection**

In `public/autocard/app.js`:

- import `fetchAPIAsset` alongside `fetchAPI`;
- keep `current.mediaUrl` null until the binary asset has loaded;
- add a monotonic media request version and a helper that revokes only `blob:` URLs;
- when selecting a new template/card, clear and revoke the old URL, render the placeholder, then asynchronously load the card's `mediaId`;
- after upload, set `current.mediaId`, clear the old URL, render the placeholder, then load the returned media id through `fetchAPIAsset('/api/autocard/media/<id>')`;
- if an older request resolves after a newer selection/upload, revoke its blob URL and ignore it;
- on load failure, keep the placeholder/icon and show a useful toast without leaving a broken `<img>` source;
- on `pagehide`, revoke the current blob URL and invalidate outstanding media loads.

Use `URL.revokeObjectURL` only for URLs created by the helper. Do not revoke `/assets/...` or `/api/...` strings.

- [ ] **Step 4: Ensure variants preserve the loaded media**

Keep `mediaHtml()` conditional on `current.mediaUrl`. Verify the employee and birthday enhancement scripts consume the loaded blob URL only after it exists. If the media is absent/loading, they must leave the existing placeholder/icon rather than emit an `<img src="undefined">` or a protected API URL.

- [ ] **Step 5: Update the changelog**

Add an Unreleased entry explaining that private AutoCard media now loads through authenticated blob URLs and that history/variants use the same path.

- [ ] **Step 6: Run focused tests**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit the media lifecycle fix**

```sh
git add public/autocard/app.js tests/unit/autocard-invariants.test.mjs CHANGELOG.md
git commit -m "fix: load AutoCard media with authenticated blobs"
```

### Task 3: Full verification and AutoCard operation audit

**Files:**
- No additional source files unless a focused regression is required by a failing check.

- [ ] **Step 1: Run the complete verification**

```sh
npm run verify
git diff --check
```

Expected: 72 or more tests pass, with `verify: ok`.

- [ ] **Step 2: Inspect the AutoCard operation contracts**

Confirm from the source and invariants that:

- template selection still renders the editor;
- uploads use `/api/autocard/media` with the caller's image content type;
- saves use JSON through `fetchAPI`;
- history loading and filters use authenticated API calls;
- edit, duplicate, and delete retain their endpoints and error handling;
- the API still protects cards/media with `authMiddleware` and `requireAutoCard`;
- variants do not bypass media loading or produce broken image URLs;
- export still receives a loaded DOM image/blob URL;
- responsive and reduced-motion styles remain unchanged.

- [ ] **Step 3: Review the final diff**

```sh
git status --short
git diff --stat HEAD~2..HEAD
git diff --check HEAD~2..HEAD
```

Confirm only authenticated asset support, AutoCard media lifecycle, tests, and changelog changed.

### Task 4: Publish and validate live AutoCard behavior

**Files:**
- No additional source files.

- [ ] **Step 1: Push and wait for CI/deploy**

```sh
git push origin main
```

Wait for validation, image publication, migration, smoke, rollback gate, and public verification to pass.

- [ ] **Step 2: Verify the live bundle**

Confirm `https://portal.ownerinc.com.br/autocard/app.js` imports `fetchAPIAsset` and no longer assigns `/api/autocard/media/<id>` directly as the image source.

- [ ] **Step 3: Validate with an authorized DHO account**

Test in a fresh session:

1. Open AutoCard and select an image-bearing template.
2. Upload a valid JPEG/PNG/WebP between 500 px minimum and 3 MB maximum.
3. Confirm the photo appears immediately.
4. Change visual variants and confirm the photo remains visible.
5. Save the card and open History.
6. Edit the saved card and confirm the photo loads.
7. Duplicate and delete the card.
8. Export PNG and confirm the image is included.
9. Test the employee and birthday variants.

- [ ] **Step 4: Confirm the private media boundary**

Without an Authorization header, confirm:

```text
GET /api/autocard/media/<id> -> 401 or 403
```

The photo must load only through the authenticated blob request.
