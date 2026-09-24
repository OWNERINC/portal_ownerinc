# Owner News Implementation Plan

> **For agentic workers:** Execute bounded parallel tasks in the existing checkout; review actual changes before integration. No commits requested.

**Goal:** Replace Anúncios with an authenticated editorial Owner News publication.

**Architecture:** Existing announcement documents, CMS revisions and protected assets
remain authoritative. Reader presentation and published filters extend current paths.

**Tech Stack:** Static HTML/CSS/ES modules, Express, PostgreSQL, Firebase; Node 18.

## Global Constraints

- Preserve pre-existing uncommitted changes, especially PDF-upload work.
- Do not modify deployment scripts or running Docker services.
- Do not introduce a second CMS, login or frontend framework.
- Authenticate all content and asset reads.

## Task 1 — Reader and shell

Own `public/announcements.html`, `public/js/announcements.js`, new dedicated CSS,
`public/js/dashboard.js`, `public/js/cms.js`, shell generator and regenerated HTML.
Keep the canonical compatible URL and expose Owner News name. Add editorial hero,
category filters, image cards, reading time, direct detail and existing CMS editing.
Consume `/api/announcements?limit=10&offset=0&category=...` and
`/api/announcements/categories` (array of strings). Detail remains `/:id`.
Reuse `renderBlocks` and authenticated asset fetching; revoke object URLs.
Add focused tests in a new Owner News frontend test file.

## Task 2 — Published API

Own `api/routes/announcements.js`, `api/cms/reader.js`, new focused API tests.
Add category query and categories endpoint before `/:id`, returning strings.
Filter validated/stable published rows before pagination and total count.
Preserve backward-compatible unfiltered behavior and current detail response.
No database schema changes required for this task.

## Task 3 — Migration

Own a new `scripts/import-owner-news.mjs`, conversion module if needed, focused
tests and migration operations document. Obtain only public source content via
read-only HTTP. Convert rich text safely to existing validated CMS blocks;
preserve attribution, dates, meaningful ordering and media relationships.
Use a dry-run default and explicit apply, deterministic source identity for
idempotence, private asset storage and transactions. Inspect local prerequisites
without printing secrets. Apply only to an identified local development database;
otherwise report the exact prerequisite and leave a runnable import command.

## Task 4 — Integration and evidence

Review diff and worker tests, run `npm run verify` and `git diff --check`.
Open running Portal in visible OpenChamber browser and inspect desktop/mobile.
Do not claim content import or authenticated browser checks without evidence.
