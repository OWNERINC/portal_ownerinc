# AutoCard Shell Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AutoCard use the same root-level Portal shell and authentication redirects as every other Portal section.

**Architecture:** Make `public/autocard.html` the canonical document, with the shared sidebar/topbar/page body and AutoCard implementation files loaded from `public/autocard/`. Update Portal navigation to use that root-level page and turn the old `/autocard/` directory entry into a compatibility redirect.

**Tech Stack:** Static HTML, vanilla JavaScript modules, CSS, Node.js built-in test runner, existing `npm run verify` checks.

## Global Constraints

- Keep AutoCard API routes, authorization rules, editor behavior, history, uploads, and export behavior unchanged.
- Keep Node 24 compatibility and the existing static multi-page architecture.
- Do not add dependencies or a client-side router.
- Preserve the existing `/autocard/` URL as a redirect for old bookmarks.
- Keep the shared Portal shell accessible with sidebar, topbar, skip link, mobile menu, and logout control.

---

### Task 1: Add failing route and shell invariants

**Files:**
- Modify: `tests/unit/autocard-invariants.test.mjs:39-63`
- Modify: `tests/unit/frontend-invariants.test.mjs:147-158`

**Interfaces:**
- Consumes the current `public/autocard.html`, `public/autocard/index.html`, and Portal page markup.
- Produces assertions for the canonical root-level page, root-level sidebar links, and legacy redirect.

- [x] **Step 1: Replace the nested-page assumptions with canonical-route assertions**

Update the AutoCard UI invariant to read `public/autocard.html` as the shell page. Assert that it contains:

```js
assert.match(html, /class="portal-wrapper"/);
assert.match(html, /class="sidebar"/);
assert.match(html, /class="topbar"/);
assert.match(html, /class="page-body"[^>]+id="main-content"/);
assert.match(html, /href="\.\/autocard\.html" class="active"/);
assert.match(html, /src="\.\/autocard\/entry\.js"/);
```

Read `public/autocard/index.html` separately and assert that it points to the canonical page:

```js
assert.match(legacy, /url=\.\.\/autocard\.html/);
assert.match(legacy, /href="\.\.\/autocard\.html"/);
```

Keep the existing assertions for the guard and API usage.

- [x] **Step 2: Add navigation assertions for root-level AutoCard links**

In the frontend invariant, read `public/dashboard.html` and assert that its AutoCard link targets the sibling page:

```js
assert.match(dashboard, /href="\.\/autocard\.html"/);
assert.doesNotMatch(dashboard, /href="\.\/autocard\/"/);
```

Keep the reduced-motion assertion against `public/autocard/styles.css`.

- [x] **Step 3: Run the focused tests and confirm they fail**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected result: FAIL because the current canonical file is only a meta-refresh stub, the sidebar points to `/autocard/`, and the test still expects the nested shell.

### Task 2: Move AutoCard to the root-level shell route

**Files:**
- Modify: `public/autocard.html:1-13`
- Modify: `public/autocard/index.html:1-96`
- Modify: `public/dashboard.html:37`
- Modify: `public/knowledge.html:36`
- Modify: `public/reminders.html:36`
- Modify: `public/academy.html:36`
- Modify: `public/benefits.html:36`
- Modify: `public/ombudsman.html:36`
- Modify: `public/profile.html:112`
- Modify: `public/admin.html:69`
- Modify: `public/solides.html:34`
- Modify: `public/autocard/guard.js:15`

**Interfaces:**
- Consumes `public/autocard/entry.js`, `public/autocard/styles.css`, and the existing shared shell files.
- Produces `autocard.html` as the canonical page and `autocard/index.html` as a compatibility redirect.

- [x] **Step 1: Replace the root stub with the AutoCard shell**

Replace `public/autocard.html` with the existing shell structure from the nested page, using root-level paths:

```html
<script src="./js/auth-shell.js"></script>
<link rel="stylesheet" href="./css/tokens.css">
<link rel="stylesheet" href="./autocard/styles.css">
<link rel="stylesheet" href="./css/layout.css">
<link rel="stylesheet" href="./css/components.css">
```

Use root-level links for every Portal item, including the active AutoCard link:

```html
<a href="./autocard.html" class="active" aria-current="page" title="AutoCard">
```

Use root-level shared asset paths and load the implementation from:

```html
<script src="./js/sidebar.js"></script>
<script type="module" src="./autocard/entry.js"></script>
```

The page must retain `#main-content`, `class="page-body"`, the skip link, sidebar toggle, topbar, and logout button.

- [x] **Step 2: Convert the old nested entry into a compatibility redirect**

Replace `public/autocard/index.html` with a minimal accessible redirect:

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=../autocard.html">
  <link rel="canonical" href="../autocard.html">
  <title>AutoCard — Portal Ownerinc</title>
</head>
<body>
  <p>Redirecionando para o AutoCard do Portal…</p>
  <p><a href="../autocard.html">Abrir AutoCard</a></p>
</body>
</html>
```

- [x] **Step 3: Update every Portal sidebar link**

Change each exact occurrence of:

```html
href="./autocard/"
```

to:

```html
href="./autocard.html"
```

Do not change the nested implementation imports or `/api/autocard/...` URLs.

- [x] **Step 4: Normalize the access-denied return link**

In `public/autocard/guard.js`, change the return link to the root-level dashboard:

```js
href: './dashboard.html'
```

This matches the canonical document depth and the redirects used by `auth.js`.

- [x] **Step 5: Run the focused tests and confirm they pass**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected result: all focused tests pass.

### Task 3: Run the complete verification and inspect the diff

**Files:**
- No additional source files.

- [x] **Step 1: Confirm no nested navigation links remain**

Run:

```sh
rg 'href="\./autocard/"' public
```

Expected result: no matches.

- [x] **Step 2: Run the full verification**

Run:

```sh
npm run verify
git diff --check
```

Expected result: verification passes, including all unit tests, syntax checks, security checks, and Compose checks.

- [x] **Step 3: Inspect the final change set**

Run:

```sh
git status --short
git diff --stat
git diff -- public/autocard.html public/autocard/index.html public/autocard/guard.js tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Confirm the diff contains only the route/shell fix and its invariants.

- [x] **Step 4: Commit the implementation**

```sh
git add public/autocard.html public/autocard/index.html public/autocard/guard.js public/dashboard.html public/knowledge.html public/reminders.html public/academy.html public/benefits.html public/ombudsman.html public/profile.html public/admin.html public/solides.html tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "fix: keep AutoCard inside the Portal shell"
```

### Task 4: Deploy and verify the live route

**Files:**
- No additional source files.

- [ ] **Step 1: Push the committed fix through the existing CI/deploy flow**

```sh
git push origin main
```

Wait for the `validate` and `deploy-production` jobs to complete successfully.

- [ ] **Step 2: Verify the canonical live page**

Check:

```text
https://portal.ownerinc.com.br/autocard.html
```

Confirm it renders the sidebar, topbar, page body, active AutoCard navigation, and editor.

- [ ] **Step 3: Verify the legacy URL**

Open:

```text
https://portal.ownerinc.com.br/autocard/
```

Confirm it redirects to `/autocard.html` and does not expose the old standalone document.

- [ ] **Step 4: Verify authenticated behavior**

With a permitted DHO user, confirm sidebar navigation, mobile menu, logout, AutoCard guard, template selection, and history still work. With a non-permitted user, confirm the root dashboard return link works.
