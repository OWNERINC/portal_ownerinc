# Cards Pos Portal Integration Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused verification after each task.

**Goal:** Integrate the `cards_pós` invitation editor into the Portal as a standalone, visually standardized page with temporary admin access and isolated API/storage.

**Architecture:** Keep the existing `AutoCard` module unchanged. Add a separate `/cards-pos.html` frontend, `/api/pos-cards/*` Express route, `pos_cards` and `pos_card_media` tables, and a dedicated `canUsePosCards` policy. The invitation preview remains Owntime-branded; only the editor shell adopts Portal tokens and components.

**Tech Stack:** Static HTML/CSS/ES modules, Express, PostgreSQL, Firebase Auth middleware, Node test runner, existing image normalization and audit helpers.

## Global Constraints

- Access is temporary for users with `role=admin`; final Pos-Vendas job titles will be added later.
- Non-authorized users must not see the navigation item and must receive `403` from every module API route.
- The Portal and `cards_pós` remain separate products; do not import `server.mjs`, `cards.json`, or the original local API.
- Preserve the invitation preview, Owntime/Ownerinc/Casa logos, image upload, history, CRUD, duplication, deletion, and PDF export.
- Reuse Portal tokens and existing dependencies. Do not add GSAP, React Bits, or another UI library.
- Keep Node 18 compatibility and run `npm run verify` before delivery.

---

### Task 1: Add Pos-Cards Policy and Navigation Access

**Files:**
- Modify: `api/middleware/policy.js`
- Modify: `api/middleware/auth.js`
- Modify: `public/js/auth.js`
- Modify: `public/js/sidebar.js`
- Modify: `public/css/layout.css`
- Test: `tests/unit/pos-cards-invariants.test.mjs`

**Interfaces:**
- Produces `POS_CARDS_JOB_TITLES`, `POS_CARDS_ADMIN_BYPASS`, and `canUsePosCards(user)` from `api/middleware/policy.js`.
- Produces `req.user.pos_cards_access` from `authMiddleware`.
- Produces `html[data-pos-cards-access="true"]` for the frontend navigation.
- Produces a dynamically inserted `.pos-cards-link` pointing to `./cards-pos.html`.

- [ ] **Step 1: Write the failing policy and navigation tests**

Assert that admins are allowed during the temporary bypass, viewers without a Pos title are denied, the policy is independent from `canUseAutoCard`, and the sidebar link is hidden by default and shown only by the data attribute. Assert that the link is inserted by `sidebar.js` with the label `Cards Pós` and the `badge-check` icon.

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/unit/pos-cards-invariants.test.mjs`

Expected: FAIL because the policy, auth field, navigation hook, and test fixture do not exist yet.

- [ ] **Step 3: Implement the smallest policy and navigation changes**

Add:

```js
const POS_CARDS_JOB_TITLES = new Set();
const POS_CARDS_ADMIN_BYPASS = true;

function canUsePosCards(user) {
  const title = String(user?.job_title || '').trim().toLocaleLowerCase('pt-BR');
  return (POS_CARDS_ADMIN_BYPASS && user?.role === 'admin') || POS_CARDS_JOB_TITLES.has(title);
}
```

Set `req.user.pos_cards_access = canUsePosCards(req.user)` in `authMiddleware`. Apply the corresponding HTML dataset in `auth.js`. Add the menu link in `sidebar.js`, keep it hidden in `layout.css`, and reveal it only with `html[data-pos-cards-access="true"]`.

- [ ] **Step 4: Run the focused test again**

Run: `node --test tests/unit/pos-cards-invariants.test.mjs`

Expected: PASS.

### Task 2: Add Isolated Pos-Cards Database Storage

**Files:**
- Create: `api/db/migrations/017_pos_cards.sql`
- Modify: `api/db/schema.sql`
- Modify: `api/db/provision.js`
- Modify: `api/db/verify-migrations.js`
- Modify: `cron/autocard-media-retention.js`
- Modify: `tests/unit/schema-invariants.test.mjs`
- Modify: `tests/unit/cron.test.mjs`

**Interfaces:**
- Creates `pos_card_media` with UUID media IDs, normalized WebP storage, `pos-card-<uuid>.webp` storage keys, and authenticated creator metadata.
- Creates `pos_cards` with UUID IDs, `convite_owntime` template validation, JSON object values, media foreign key, creator metadata, and timestamps.
- Grants `portal_api` CRUD access and `portal_cron` cleanup access only to the new tables.

- [ ] **Step 1: Add failing schema assertions**

Extend migration and schema tests to require migration `017_pos_cards`, both tables, the `convite_owntime` template check, the `pos-card-` storage-key check, API grants, cron grants, and migration verification markers.

- [ ] **Step 2: Run schema tests to verify failure**

Run: `node --test tests/unit/schema-invariants.test.mjs tests/unit/cron.test.mjs`

Expected: FAIL because the tables, grants, migration ledger entry, and retention handling are absent.

- [ ] **Step 3: Create the migration and fresh-install schema**

Define `pos_card_media` and `pos_cards` with `ON DELETE SET NULL` for media references, `CHECK (jsonb_typeof("values") = 'object')`, name length 1-120, content types limited to JPEG/PNG/WebP, byte size capped at 3 MiB, and indexes on updated time and template. Add the same definitions to `api/db/schema.sql` and its migration ledger.

- [ ] **Step 4: Add grants and retention cleanup**

Grant `portal_api` select/insert/update/delete on both tables. Grant `portal_cron` select on `pos_cards` and select/delete on `pos_card_media`. Extend the existing retention worker to recognize `pos-card-<uuid>.webp`, delete unreferenced Pos media using the same advisory-lock pattern, and report invalid Pos storage keys without touching AutoCard files.

- [ ] **Step 5: Verify schema and retention assertions**

Run: `node --test tests/unit/schema-invariants.test.mjs tests/unit/cron.test.mjs`

Expected: PASS.

### Task 3: Add Protected Pos-Cards API

**Files:**
- Create: `api/routes/pos-cards.js`
- Modify: `api/index.js`
- Test: `tests/unit/pos-cards-api-invariants.test.mjs`

**Interfaces:**
- Exposes `GET /api/pos-cards/access` with `{ allowed: true }` only after policy approval.
- Exposes card CRUD, search, duplication, deletion, and upload/media delivery under `/api/pos-cards`.
- Reuses `authMiddleware`, `normalizeImage`, `uuid`, `invalid`, `forbidden`, `parseListQuery`, and `withAudit`.

- [ ] **Step 1: Write failing route contract tests**

Assert that the route is mounted, uses auth and `canUsePosCards`, accepts only `convite_owntime`, validates names and object values, limits JSON size, stores normalized WebP media, returns private media responses, audits writes, and returns `403` before database work for unauthorized users.

- [ ] **Step 2: Run the route contract test to verify failure**

Run: `node --test tests/unit/pos-cards-api-invariants.test.mjs`

Expected: FAIL because the route and mount do not exist.

- [ ] **Step 3: Implement the protected route**

Follow the existing `api/routes/autocard.js` response shape, but use only `pos_cards` and `pos_card_media`. Use `pos-card-${id}.webp` storage keys, normalize uploads through `normalizeImage`, return `requestId` on errors, use `withAudit` for create/update/duplicate/delete/media writes, and protect every route with `authMiddleware` plus `canUsePosCards`.

- [ ] **Step 4: Mount and run the route contract test**

Mount with `app.use('/api/pos-cards', posCardsRoutes)` in `api/index.js` and run:

```sh
node --test tests/unit/pos-cards-api-invariants.test.mjs
```

Expected: PASS.

### Task 4: Migrate and Standardize the Frontend Page

**Files:**
- Create: `public/cards-pos.html`
- Create: `public/cards-pos/app.js`
- Create: `public/cards-pos/styles.css`
- Create: `public/cards-pos/guard.js`
- Create: `public/cards-pos/assets/owntime-logo-white.webp`
- Create: `public/cards-pos/assets/ownerinc-logo-white.png`
- Create: `public/cards-pos/assets/casa-logo-white.svg`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- `guard.js` exports `requirePosCards()` and redirects unauthorized users to the Portal dashboard after showing a clear access state when the API denies access.
- `app.js` reads the existing `data-field` form contract, calls `/api/pos-cards/*`, renders the invitation preview, uploads media, handles history, and exports the preview through the browser print dialog.

- [ ] **Step 1: Add failing frontend invariants**

Assert that the page uses the Portal shell, skip link, shared CSS tokens, `cards-pos` API paths, no original `server.mjs`/`cards.json` references, no external Google Fonts import, visible form labels, `aria-live` status, print styles, and the invitation content fields from the source project.

- [ ] **Step 2: Run the frontend test to verify failure**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: FAIL because the page and module files do not exist.

- [ ] **Step 3: Create the authenticated Portal page**

Use the existing sidebar/topbar structure, add `cards-pos/styles.css` after shared styles, load Lucide and the existing Firebase/auth module, include the editor/history sections, and call `requirePosCards()` before initializing the editor.

- [ ] **Step 4: Port the editor behavior**

Move the source project's defaults, escaped rendering, upload validation, save/edit/duplicate/delete/history flows, image preview, and print preparation into `cards-pos/app.js`. Replace local API calls with `/api/pos-cards/cards` and `/api/pos-cards/media`. Use authenticated `fetchAPI` and `fetchAPIAsset` rather than raw unauthenticated fetches.

- [ ] **Step 5: Apply Portal visual standards without changing the invitation art direction**

Use Portal semantic tokens for page background, surface, borders, primary action, focus, spacing, radius, and shadows. Keep the preview card's cream, warm-neutral, Owntime composition and vertical format. Make the editor panel and preview stage responsive, keep inputs at least 44px high, add visible focus/pressed/disabled states, add reduced-motion rules, and keep the PDF print layout isolated from the Portal shell.

- [ ] **Step 6: Copy only required local assets and run frontend invariants**

Copy the three existing logo assets from `C:\Ownerinc\projects\cards_pós` into `public/cards-pos/assets/`, then run:

```sh
node --test tests/unit/pos-cards-frontend.test.mjs
```

Expected: PASS.

### Task 5: Complete Cross-Feature Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/product/feature-inventory.md`
- Modify: `tests/unit/frontend-invariants.test.mjs`
- Modify: `tests/unit/api-security.test.mjs`

**Interfaces:**
- Documentation identifies `Cards Pós` as a separate Portal module with temporary admin access.
- Existing AutoCard behavior and DHO policy remain unchanged.

- [ ] **Step 1: Add regression assertions**

Assert that existing AutoCard allowlist behavior is unchanged, `canUsePosCards` is not used by AutoCard routes, the new page and link do not expose data to non-authorized users, and the new migration is present in the expected ordered ledger.

- [ ] **Step 2: Run the complete verification suite**

Run:

```sh
npm run verify
git diff --check
```

Expected: PASS with no secrets, external project data, `node_modules`, `.env`, or standalone server files added to the Portal.

- [ ] **Step 3: Review the final diff**

Confirm that only the Portal repository changed, the original `C:\Ownerinc\projects\cards_pós` project was not modified, and the admin bypass is clearly isolated in `POS_CARDS_ADMIN_BYPASS` for the later role rollout.
