# CMS Drag and Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a secure block-based CMS with drafts, publication, scheduling, protected assets, and editor support across Knowledge, Academy, Benefits, Announcements, and Reminders.

**Architecture:** Existing domain tables remain authoritative for metadata and operational behavior. `cms_documents` and `cms_revisions` hold block content and publication state, linked to existing records by type/id; announcements use standalone CMS documents. The browser uses a native drag-and-drop block editor and shared safe renderer, while the API validates every block and enforces area permissions.

**Tech Stack:** Node.js 24, Express, PostgreSQL migrations, static HTML/ES modules, native HTML Drag and Drop, existing authenticated upload/storage patterns, Node test runner.

## Global Constraints

- Use the five areas: Base de Conhecimento, Academia, Benefícios, Comunicados e Avisos, and Lembretes.
- Preserve existing domain fields and legacy text rendering as fallback.
- Use `draft`, `published`, and `scheduled` revision states; only one revision is published per document.
- Use native block reordering; do not add a canvas editor or arbitrary HTML execution.
- Validate `heading`, `paragraph`, `list`, `callout`, `image`, `divider`, `link`, `pdf`, and `video` blocks on the server.
- `manageKnowledge`, `manageAcademy`, `manageBenefits`, and `manageReminders` remain the area permissions; announcements use `manageKnowledge`.
- Keep reminder recurrence, audience, channel, retry, and `notifications_log` behavior unchanged.
- Private images/PDFs require authenticated API access; no raw filesystem paths or secrets reach the browser.
- Preserve Node 24 compatibility, API/public boundaries, audit logging, and migration rollback safety.

---

### Task 1: CMS schema, block validation, and asset storage

**Files:**
- Create: `api/db/migrations/015_cms_editor.sql`
- Create: `api/cms/blocks.js`
- Create: `api/cms/permissions.js`
- Modify: `api/db/verify-migrations.js`
- Modify: `scripts/test-migrations.mjs`
- Modify: `tests/unit/schema-invariants.test.mjs`
- Create: `tests/unit/cms-blocks.test.mjs`

**Interfaces:**
- `validateBlocks(value)` returns a normalized block array or `null`.
- `blocksToText(blocks)` returns safe plain text for reminder email delivery.
- `canManageCms(user, contentType)` returns a boolean using the existing permissions.

- [ ] **Step 1: Add failing block validator tests.**

  Cover all nine block types, required fields, maximum text lengths, safe HTTPS URLs, list items, image alt text, PDF asset IDs, rejection of unknown keys/types, rejection of scripts/HTML, and `blocksToText` output.

- [ ] **Step 2: Add migration and migration expectations.**

  Create `015_cms_editor` with:

  ```sql
  CREATE TABLE cms_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type TEXT NOT NULL CHECK (content_type IN ('knowledge', 'academy', 'benefit', 'announcement', 'reminder')),
    source_id UUID,
    title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    category TEXT NOT NULL DEFAULT '' CHECK (char_length(category) <= 100),
    published_revision_id UUID,
    draft_revision_id UUID,
    scheduled_revision_id UUID,
    scheduled_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_type, source_id)
  );

  CREATE TABLE cms_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES cms_documents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'scheduled', 'archived')),
    blocks JSONB NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
    created_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, version)
  );
  ```

  Add the three revision foreign keys after both tables exist, create indexes for `(content_type, source_id)` and revision status, and create `cms_assets` for private image/PDF/video files with UUID storage keys, MIME allowlist, byte limits, uploader, and timestamps. Add migration version assertions and verify the new tables/constraints in integration tests.

- [ ] **Step 3: Implement strict block validation and permission mapping.**

  Keep the validator dependency-free. Each block has a `type` plus only the fields allowed for that type; reject unknown properties. Use existing URL and text validation helpers where possible. `canManageCms` maps `knowledge`/`announcement` to `manageKnowledge`, `academy` to `manageAcademy`, `benefit` to `manageBenefits`, and `reminder` to `manageReminders`.

- [ ] **Step 4: Run focused tests and commit.**

  Run `node --test tests/unit/cms-blocks.test.mjs tests/unit/schema-invariants.test.mjs` and `npm run test:migrations` when PostgreSQL is available, then commit `feat: add cms document and revision storage`.

### Task 2: CMS API for drafts, publishing, scheduling, and protected assets

**Files:**
- Create: `api/routes/cms.js`
- Create: `api/routes/cms-assets.js`
- Modify: `api/index.js`
- Modify: `tests/unit/api-routes.test.mjs`
- Modify: `tests/unit/api-security.test.mjs`
- Create: `tests/unit/cms-routes.test.mjs`

**Interfaces:**
- `GET /api/cms/documents?type=&status=&source_id=` lists authorized documents.
- `POST /api/cms/documents` creates an authorized document or links an existing domain record.
- `GET /api/cms/documents/:id` returns metadata, current draft, published revision, and scheduling state.
- `PUT /api/cms/documents/:id/draft` validates blocks and creates the next draft revision.
- `POST /api/cms/documents/:id/publish` publishes a selected draft revision atomically.
- `POST /api/cms/documents/:id/schedule` schedules a draft with a future ISO timestamp.
- `POST /api/cms/documents/:id/unpublish` archives the published revision without deleting it.
- `DELETE /api/cms/revisions/:id` discards only draft revisions.
- `POST /api/cms/assets` uploads an authenticated private asset and returns its UUID metadata.
- `GET /api/cms/assets/:id` streams an authorized private asset.

- [ ] **Step 1: Add failing route/security tests.**

  Cover unauthorized requests, wrong area permissions, invalid block payloads, draft creation, atomic publish, schedule rejection for past dates, unpublish, draft-only deletion, and private asset access. Assert each mutation calls the audit helper and never returns filesystem paths.

- [ ] **Step 2: Implement document/revision transactions.**

  Use `withAudit` and PostgreSQL transactions. Draft saves increment `version`; publish archives the previous published revision, sets `published_revision_id`, clears the draft pointer, and sets `published_at`; scheduling sets `scheduled_revision_id` and `scheduled_at` without exposing it as published. A published revision is immutable.

- [ ] **Step 3: Implement safe asset upload/streaming.**

  Reuse the existing authenticated upload boundary, validate file signatures, accept image/PDF/video allowlists, store UUID-shaped keys in the existing upload volume, and stream only after authentication and document authorization. Do not add a public Nginx upload path.

- [ ] **Step 4: Register routes and run focused tests.**

  Mount `/api/cms` and `/api/cms/assets`, run `node --test tests/unit/cms-routes.test.mjs tests/unit/api-routes.test.mjs tests/unit/api-security.test.mjs`, and commit `feat: add cms publication api`.

### Task 3: Published content integration and reminder rendering

**Files:**
- Create: `api/cms/published.js`
- Modify: `api/routes/knowledge.js`
- Modify: `api/routes/academy.js`
- Modify: `api/routes/benefits.js`
- Modify: `api/routes/reminders.js`
- Modify: `cron/checkReminders.js`
- Create: `api/routes/announcements.js`
- Modify: `api/index.js`
- Create: `tests/unit/cms-publication.test.mjs`

**Interfaces:**
- `getPublishedBlocks(pool, contentType, sourceId)` returns published blocks, or `null` for legacy fallback.
- Existing area list/detail routes add `content_blocks` only when published content exists and otherwise preserve current fields.
- `GET /api/announcements` returns published/scheduled-ready announcements for authenticated users.

- [ ] **Step 1: Add fallback/publication tests.**

  Assert legacy rows remain readable without CMS documents, published revisions are returned, drafts are hidden, scheduled revisions appear only at/after `scheduled_at`, and unauthorized area management remains unchanged.

- [ ] **Step 2: Implement publication resolver.**

  Resolve `published_revision_id` first, then promote a due scheduled revision in one transaction. Never return draft blocks. Add `content_blocks` to existing API payloads without removing text fields.

- [ ] **Step 3: Add announcements and reminder text rendering.**

  Add the announcement list/detail route using the `announcement` document type. In `checkReminders`, use `blocksToText` for the published reminder revision and retain `description` as fallback; do not change claim, retry, audience, channel, or notification status logic.

- [ ] **Step 4: Run tests and commit.**

  Run `node --test tests/unit/cms-publication.test.mjs tests/unit/notification-scheduling.test.mjs tests/unit/api-routes.test.mjs` and commit `feat: integrate published cms content`.

### Task 4: Native Drag and Drop editor, renderer, and CMS administration

**Files:**
- Create: `public/js/cms-block-editor.js`
- Create: `public/js/cms-block-renderer.js`
- Create: `public/js/cms.js`
- Create: `public/cms.html`
- Create: `public/css/cms.css`
- Modify: `public/admin.html`
- Modify: `public/knowledge.html`
- Modify: `public/js/knowledge.js`
- Modify: `public/academy.html`
- Modify: `public/js/academy.js`
- Modify: `public/benefits.html`
- Modify: `public/js/benefits.js`
- Create: `public/announcements.html`
- Create: `public/js/announcements.js`
- Modify: shared sidebar/navigation markup in the affected HTML pages
- Create: `tests/unit/cms-frontend.test.mjs`

**Interfaces:**
- `createBlockEditor({ root, initialBlocks, onChange })` creates a native drag-and-drop editor.
- `renderBlocks(container, blocks, options)` renders only validated block types using DOM APIs.
- `cms.js` calls the Task 2 API and exposes create/edit/preview/save/publish/schedule/unpublish flows.

- [ ] **Step 1: Add renderer/editor tests.**

  Assert block rendering uses text nodes/DOM properties instead of unsafe HTML, drag reorder changes block order, keyboard move controls exist, invalid blocks are rejected, preview matches published rendering, and PDF buttons point to authenticated asset endpoints.

- [ ] **Step 2: Implement renderer and editor.**

  Build a toolbar for the nine block types, one block per row with drag handle and keyboard move buttons, delete/duplicate controls, empty-state guidance, and responsive preview. Serialize only the strict block schema.

- [ ] **Step 3: Implement CMS administration and area navigation.**

  Add a CMS page with area filter, document list, draft/published/scheduled badges, block editor, preview, publish and scheduling controls. Hide mutation controls unless the backend/user permission allows the area. Keep the existing Admin pages functional.

- [ ] **Step 4: Integrate published rendering and legacy fallbacks.**

  Render `content_blocks` in Knowledge, Academy, Benefits, and Announcements. Keep text fields visible when blocks are absent. Keep reminder UI structured and use text fallback for display.

- [ ] **Step 5: Run frontend tests and commit.**

  Run `node --test tests/unit/cms-frontend.test.mjs tests/unit/frontend-invariants.test.mjs`, then commit `feat: add drag and drop cms editor`.

### Task 5: Full verification, migration validation, and deployment

**Files:**
- Modify: `docs/operations/v1-release-checklist.md`
- Modify: `CHANGELOG.md`
- Verify all files from Tasks 1-4.

- [ ] **Step 1: Run the complete verification.**

  Run `npm run verify`, `npm run test:migrations`, and `git diff --check`. Confirm the migration runs twice and the five content areas remain readable.

- [ ] **Step 2: Run the manual acceptance flow.**

  Create a Knowledge article draft with heading, callout, image, and PDF; preview it; publish it; edit a new draft; schedule a future revision; verify the old published revision remains visible. Repeat a minimal publish flow for Academy, Benefits, Announcements, and a Reminder without changing recurrence settings.

- [ ] **Step 3: Commit documentation and inspect the final diff.**

  Update the release checklist only with verified evidence, run `git status --short`, `git diff --stat`, `git diff --check`, and commit `feat: ship drag and drop cms`.

- [ ] **Step 4: Push and deploy.**

  Push `main`, wait for PostgreSQL migration tests, image scans, production deployment, and smoke checks. Verify `https://portal.ownerinc.com.br` returns HTTP 200 and validate one published document and one protected PDF in the live environment.
