# Editorial Operational Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a local-only visual pass for the Ownerinc Portal using the approved Editorial operational direction.

**Architecture:** Keep the static HTML, shared generated shell, existing JavaScript behavior, and API contracts intact. Refine the shared token/layout/component layer first, then align the dashboard, preview, and CMS surfaces with those tokens; AutoCard and Cards Pos remain functional and inherit only safe shared improvements.

**Tech Stack:** Static HTML/CSS/JavaScript, existing Node verification scripts, no new dependency.

## Global Constraints

- Do not deploy to production.
- Preserve authentication, permissions, API routes, storage, and generated shell markers.
- Keep the black/gold Ownerinc identity, with gold reserved for actions, selection, and status.
- Preserve mobile drawer behavior, keyboard focus, reduced motion, and responsive table containment.
- Use `npm run verify` and `git diff --check` before presenting the local result.

---

### Task 1: Shared Visual Foundation

**Files:**
- Modify: `public/css/tokens.css`
- Modify: `public/css/layout.css`
- Modify: `public/css/components.css`
- Test: `tests/unit/frontend-invariants.test.mjs` via `npm run verify`

**Interfaces:**
- Consumes: existing CSS custom properties and shell class names.
- Produces: the same selectors and interaction contracts with a warmer, clearer editorial visual system.

- [x] **Step 1: Update shared tokens**

  Tune the existing background, surface, border, text, primary, focus, radius, spacing, and shadow values without adding a second token system or changing selectors.

- [x] **Step 2: Refine shell geometry**

  Improve sidebar spacing, topbar height, page padding, active navigation treatment, and mobile spacing while preserving the existing `.sidebar-open`, `.sidebar-collapsed`, `.main-content`, `.mobile-menu-toggle`, and `.sidebar-overlay` contracts.

- [x] **Step 3: Refine shared components**

  Improve cards, buttons, badges, form controls, tables, dialogs, toasts, pagination, and empty states using the shared tokens. Keep all focus-visible and reduced-motion behavior intact.

- [x] **Step 4: Run the frontend invariants**

  Run `npm run verify`.

  Expected: all existing tests pass with no generated-shell or accessibility-contract regression.

### Task 2: Editorial Surfaces

**Files:**
- Modify: `public/css/dashboard-home.css`
- Modify: `public/css/home-preview.css`
- Modify: `public/css/knowledge.css`
- Modify: `public/css/cms.css`
- Test: `tests/unit/home-preview.test.mjs` and `npm run verify`

**Interfaces:**
- Consumes: shared tokens and existing page class names.
- Produces: a consistent dashboard, catalog, and CMS visual hierarchy without changing page data flow.

- [x] **Step 1: Align dashboard and preview composition**

  Keep the editorial hero, story rails, area cards, and responsive mobile rail, but calibrate section rhythm, headings, card borders, and action links to the shared visual foundation.

- [x] **Step 2: Align catalog pages**

  Refine Knowledge list/search/filter/article states and the shared content-card language without changing URL state, pagination, or safe rendering.

- [x] **Step 3: Align CMS tooling**

  Keep the CMS's warm editor surface as a tool context, but replace conflicting accent and text values with the shared Ownerinc action/focus tokens where the current selectors already support it.

- [x] **Step 4: Run focused checks**

  Run `node --test tests/unit/home-preview.test.mjs` and then `npm run verify`.

  Expected: the home preview contracts, responsive CSS contracts, and full verification remain green.

### Task 3: Local Review Package

**Files:**
- Modify: no production configuration or deployment files.
- Test: `git diff --check`, `npm run verify`

**Interfaces:**
- Consumes: the branch's CSS changes.
- Produces: a locally runnable branch and a concise review note describing what changed and what remains deferred.

- [x] **Step 1: Review the diff**

  Run `git diff --stat`, `git diff --check`, and inspect the changed CSS for accidental selector or contract changes.

- [x] **Step 2: Run the local server**

  Start the existing static/API development command documented in `README.md`, without Docker or production deployment.

- [ ] **Step 3: Inspect responsive routes locally**

  Check `/dashboard.html`, `/home-preview.html`, `/knowledge.html`, `/admin.html`, `/cms.html`, `/autocard.html`, and `/cards-pos.html` at desktop and mobile widths.

- [ ] **Step 4: Report the branch state**

  Provide the branch name, local URL, verification result, and explicit confirmation that no production deploy was run.
