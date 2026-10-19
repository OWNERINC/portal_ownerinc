# Task 1 report — Portal page domain contracts

## Initial NEEDS_CONTEXT pause — resolved

The first pass stopped before code changes because the initial brief left title/slug limits, content-size basis, canonical block schemas, and public revision identity unspecified. The user resolved these points with exact contract decisions; implementation then proceeded without borrowing Owner News DTO types or limits.

Context reviewed: Task 1 brief and SDD ledger; `README.md`; `docs/product/brief.md`; `docs/architecture/overview.md`; and existing CMS News patterns, which were used only as conventions.

## Implementation

- Added page-local primitives, safe block/rich-text types, public DTO types, normalization, and validation under `cms/src/portal-pages/`.
- The public content normalizer enforces exact block and nested key allowlists, all five layouts, UUID media references, safe Unicode/plain-text boundaries, HTTPS URLs, canonical YouTube/Vimeo embed URLs, 100 blocks, 10,000 rich nodes, inline depth four, and the inclusive 5 MiB UTF-8 JSON boundary over normalized public blocks.
- DTO validation returns normalized slug/content and enforces the exact `PortalPageDTO` keys, `portal-pages` vs `portal-pages-preview` revision status, and strict expected-version publication input.
- Media constants are exactly JPEG, PNG, WebP, PDF, MP4 and WebM; MOV/QuickTime is excluded.
- Added `docs/architecture/portal-pages-content.md` documenting the public DTO/native Payload boundary and all approved authorization, News isolation, upload, media-session, revision binding, publication, retention, gallery, navigation, and migration constraints.
- Native Payload draft projection, collection wiring, asset existence/MIME lookup, routes, UI, uploads, migrations, and deploy changes remain out of scope for this task.

## TDD evidence

- **RED:** before implementation, `node --import tsx --test tests/unit/portal-pages.test.ts` from `cms/` failed because `cms/src/portal-pages` did not yet exist (`ERR_MODULE_NOT_FOUND`).
- **GREEN:** after implementation, the focused test file passed all 14 tests.

## Verification

- `npm run test:unit` from `cms/`: **462 passed, 0 failed, 11 skipped**. Skips are existing environment-gated PGlite/Windows durability cases. This includes the relevant existing Owner News content tests.
- `npm run typecheck` from `cms/`: passed.
- `git diff --cached --check`: passed during staging/review.
- No Docker, service startup, database, production operation, or remote system was used.

## Files changed

- `cms/src/portal-pages/primitives.ts`
- `cms/src/portal-pages/blocks.ts`
- `cms/src/portal-pages/contracts.ts`
- `cms/src/portal-pages/rich-text.ts`
- `cms/src/portal-pages/validation.ts`
- `cms/src/portal-pages/index.ts`
- `cms/tests/unit/portal-pages.test.ts`
- `docs/architecture/portal-pages-content.md`
- `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-1-report.md`

## Self-review and concerns

- Confirmed the new modules contain no imports from `cms/src/news/`; `NewsDTO`, access gates, native locks, global parser configuration, APIs, collections, and database schema are unchanged.
- Embed source URLs are restricted to the approved providers and paths; the Vimeo player host is accepted only when validating the already-normalized public DTO output.
- The publication input validator establishes shape only. Comparing `expected_version_id` to the latest saved Payload version and enforcing asset/reference behavior belong to later mutation/collection work.
- The 11 skipped tests are pre-existing optional environment/platform checks; all runnable CMS unit tests passed.

## Commit

Focused implementation commit created after final review; see the task result for its hash.
