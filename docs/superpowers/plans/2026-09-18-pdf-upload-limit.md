# PDF Upload Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise CMS PDF uploads from 50 MB to 100 MB while keeping every other CMS asset at 50 MB.

**Architecture:** Keep the existing multipart endpoint and Multer memory storage. Let the transport accept the largest supported file, detect the actual MIME from bytes, then apply a MIME-specific size limit before writing to disk.

**Tech Stack:** Express, Multer, static browser JavaScript, Nginx, Node.js built-in test runner.

## Global Constraints

- PDFs are limited to `100 * 1024 * 1024` bytes.
- Images and videos remain limited to `50 * 1024 * 1024` bytes.
- The two exact CMS asset upload locations use `client_max_body_size 101m`.
- Oversized files return HTTP `413` and are not written.
- Keep Multer memory storage; add no dependency or streaming subsystem.

---

### Task 1: MIME-specific CMS upload limits

**Files:**
- Modify: `tests/unit/cms-routes.test.mjs:364-379,617-631`
- Modify: `tests/unit/cms-frontend.test.mjs`
- Modify: `tests/unit/operations-invariants.test.mjs:161`
- Modify: `api/routes/cms-assets.js:15-30,304-310`
- Modify: `public/js/knowledge.js:396-397,743-744`
- Modify: `nginx/nginx.conf:185,200`
- Modify: `docs/product/feature-inventory.md:85`

**Interfaces:**
- Consumes: detected MIME from `detectedMime(buffer)` and `req.file.size` from Multer.
- Produces: PDF ceiling of 100 MB, non-PDF ceiling of 50 MB, and edge ceiling of 101 MB.

- [ ] **Step 1: Update contract tests to the new limits**

In `tests/unit/cms-routes.test.mjs`, replace the old single-limit assertion with:

```js
assert.match(assets, /MAX_ASSET_SIZE = 50 \* 1024 \* 1024/);
assert.match(assets, /MAX_PDF_SIZE = 100 \* 1024 \* 1024/);
assert.match(assets, /fileSize: MAX_PDF_SIZE/);
assert.match(assets, /mimeType === 'application\/pdf' \? MAX_PDF_SIZE : MAX_ASSET_SIZE/);
assert.match(assets, /req\.file\.size > maxSize[\s\S]*status\(413\)/);
```

Change both CMS upload location assertions from `51m` to `101m`. Make the same Nginx expectation change in `tests/unit/operations-invariants.test.mjs`.

In `tests/unit/cms-frontend.test.mjs`, add a source contract for both PDF entry points:

```js
test('Knowledge accepts PDF attachments up to 100 MB', () => {
  assert.equal((knowledge.match(/file\.size > 100 \* 1024 \* 1024/g) || []).length, 2);
  assert.equal((knowledge.match(/O PDF deve ter no máximo 100 MB\./g) || []).length, 2);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```sh
node --test tests/unit/cms-routes.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/operations-invariants.test.mjs
```

Expected: FAIL because the API, frontend, and Nginx still use 50/51 MB.

- [ ] **Step 3: Apply MIME-specific API limits**

In `api/routes/cms-assets.js`, define:

```js
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const MAX_PDF_SIZE = 100 * 1024 * 1024;
```

Set Multer's `fileSize` to `MAX_PDF_SIZE`. In `handleAssetUpload`, preserve signature and declared-MIME validation, then apply:

```js
const maxSize = mimeType === 'application/pdf' ? MAX_PDF_SIZE : MAX_ASSET_SIZE;
if (req.file.size > maxSize) {
  return res.status(413).json({ error: 'Asset too large.', requestId: req.id });
}
```

Keep empty files invalid and run the size check before creating directories, writing files, or opening a database transaction.

- [ ] **Step 4: Align browser, edge, and documentation limits**

In both PDF selection paths in `public/js/knowledge.js`, change the numeric check and visible message from 50 MB to 100 MB.

In the two exact CMS asset upload locations in `nginx/nginx.conf`, change:

```nginx
client_max_body_size 51m;
```

to:

```nginx
client_max_body_size 101m;
```

In `docs/product/feature-inventory.md`, change the PDF capability description from `até 50 MB` to `até 100 MB`.

- [ ] **Step 5: Run focused and full verification**

Run:

```sh
node --test tests/unit/cms-routes.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/operations-invariants.test.mjs
```

Expected: PASS.

Run:

```sh
npm run verify
```

Expected: all repository checks pass.

- [ ] **Step 6: Inspect the final diff**

Run:

```sh
git diff --check
```

Expected: no whitespace errors. Do not commit unless the user explicitly requests it.
