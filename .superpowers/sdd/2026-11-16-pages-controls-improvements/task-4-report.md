# Task 4 — actionable publication issues

## Outcome and boundaries

Implemented Task 4 only on `ec87971`. Publication blockers are visible in a review
list with a summary and safe Corrigir actions. The existing `publicationIssues`
string-array contract retains its exact messages, order and aggregate rules;
there is one publication-only validator, not a parallel validator. Optional
personal checks are visibly explained and do not claim third-party approval.

Read the task brief (including globals/approved UX), README, product brief, Pages
architecture and Task 3 report; did not read the whole plan. Loaded uncodixfy,
brainstorming and review guidance. The supplied approved UX/interface is the
design input; this is not an additional unapproved product design. Reviewed the
localized diff inline; did not spawn subagents, as explicitly requested. Parent
review remains appropriate before integration.

No changes to backend/API, migrations, grants, cron, Nginx, deploy, dependencies,
production, real content, or authorization. No Docker services started. No autosave
or implicit v1/v2/v3 conversion on review/navigation. Existing unrelated untracked
historical screenshots were left untouched. No reference image was overwritten.

## Files and interfaces

- `public/pages/publication-issues.js`:
  `publicationIssueDetails(document,cargos)` returns
  `{code,message,blockId?,itemId?,field?}[]`. Contains the extracted original
  publication rules. Image and AV checks remain one aggregate message each;
  their destination is the first failing block. Gallery/FAQ/embed checks retain
  their original document-order/item-order messages. Appearance issues retain
  complete messages without inventing an editable target from an inline or
  inherited contrast path.
  `publicationIssueTarget(document,issue)` resolves stable block/item IDs and a
  currently present field; absent blocks/items/fields return null. Metadata
  destinations are explicitly limited to title/audience. No document mutation.
- `public/pages/model.js`: `publicationIssues(doc,cargos)` is only
  `publicationIssueDetails(doc,cargos).map(issue => issue.message)`.
- `public/pages/editor-review.js`: adds optional `onIssue(issue)` to `openReview`.
  A correction resolves the current destination before closing, then closes
  without returning focus to the old opener and calls `onIssue`. Removed targets
  keep the review open and show an explanatory message. No callback/readonly/no
  safe target means no invented correction button. Existing editing/busy/checking/
  composition guards apply. Lists rebuild only when details/editability change,
  not on every refresh; status text is only replaced when its message changes.
  Personal checks have a visible optional legend and non-persisted/non-approval
  explanation; third checkbox now says “Conferi o conteúdo”.
- `public/pages/editor.js`: callback is bound to the originating state/visit/load
  sequence and current editing/history guards. Opens Page properties for title
  and audience, expands the existing audience disclosure, selects current blocks,
  expands the actual FAQ item, focuses keyed answer EditorViews/native fields or
  safe replacement/add actions. It never clicks a picker or uploads automatically.
  Empty FAQ resolves its actual fields container, not its drag handle.
- `public/pages/editor-media.js`: adds `data-publication-field` to existing native
  controls and captions JSON. Does not clone inputs/editors or add another form.
- `public/css/pages-editor-v2.css`: localized review rules replace conflicting
  old 37/36px controls and invisible pseudo-targets. Centered native modal, 16px
  safe margins, retained header/footer and internally scrolling body. 44px real
  controls/rows, 18px checkbox indicators, 16px text inputs, 8px label/control and
  16px group spacing. Focus-outline room in body. Existing product palette.
- `public/pages/vendor/editor.js`: regenerated with `npm run build:pages`, needed
  by the pinned reproducible-build gate after changing the model dependency graph.
  No vendor dependency/version/license changes. The build/verification scripts
  themselves are unchanged.
- Unit preflight/review tests: exact independent message arrays, structured parity,
  v1/v2/v3 aggregate behavior, destination removal, no mutation, checks cannot
  bypass blockers or regenerate a pending publication key. Lifecycle VM harness
  loads the new real module (not a stub validator).
- `tests/visual/pages-editor-review-controls.mjs`: new reusable `review` scenario
  in `pages-editor-controls.mjs`; stable `check-pages-controls.mjs` entry retained.
- `tests/visual/check-pages-publication-preflight.mjs`: updated only the renamed
  personal checkbox selector; all publication/preflight checks retained.
- `tests/visual/check-pages-review.mjs`: preserves the original source SHA check
  and exact historical `near()` assertions under `--strict-reference-geometry`.
  Normal mode records each intentional geometry difference, does not claim source
  fidelity, and additionally asserts retained 580px horizontal frame, centering,
  field insets/widths/44px heights, 88px field rhythm and footer insets.
- `docs/architecture/pages.md`: updated interface/semantics/reproduction contract.

### Preserved safety contracts

`createReviewSession`, its WeakMap lifetime, exact revision/version/fingerprint,
subscription invalidation, pending payload freezing, remote head verification,
CAS checks and receipt reconciliation are unchanged. The click-time publication
check still calls the canonical string-array wrapper. Current content blockers
apply to new writes, not to reconciling an already uncertain immutable receipt.
No checkbox is required for publishing or included in the backend payload.
Save remains explicit, permissions remain authoritative, and no bypass was added.

## Reproduction environment

PowerShell, existing external installations; no installs:

```powershell
$env:PGLITE_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js'
$env:PLAYWRIGHT_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/playwright/index.mjs'
$env:AXE_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/@axe-core/playwright/dist/index.mjs'
$env:PAGES_REFERENCE_DIR='C:/Users/Criação/AppData/Local/Temp/opencode/editor-v2-reference'
$env:FFMPEG_PATH=(Get-Command ffmpeg).Source
$env:FFPROBE_PATH=(Get-Command ffprobe).Source
```

All evidence/log directory names below are relative to
`C:/Users/Criação/AppData/Local/Temp/opencode/`. Output variables were always set
to fresh directories; no historical artifact was reused or overwritten.

## Red → green, failures and commands

1. Before product implementation:
   `node --test tests/unit/pages-publication-preflight.test.mjs` exited 1 with
   `ERR_MODULE_NOT_FOUND` for `publication-issues.js`, as expected.
2. Before product implementation:
   `$env:PAGES_CONTROLS_OUTPUT='.../pages-task4-red-20261116a'` then
   `node tests/visual/check-pages-controls.mjs review` exited 1:
   **publication issues must be visible, not only in tooltip**. Actual local
   template, real workspace/API/SQL, 320px review screenshot preserved there.
3. First green attempt `pages-task4-green-20261116a` reached correction/save, then
   a test polling predicate dereferenced a not-yet-created modal checkbox after
   reopening. Fixed the predicate to wait for existence and enabled state; no
   product guard changed. `...green-20261116b` passed all four widths.
4. Visual inspection exposed a preexisting checkbox selector collision: generic
   review input styles made cargo indicators large. Restricted text input rules
   to non-checkboxes, retained 18px cargo indicators, and added a measured browser
   assertion plus axe A/AA. `...green-20261116c` passed.
5. Initial complete verify (`pages-task4-verify-20261116a.log`) failed: reproducible
   vendor bundle was stale, and a redundant model re-export was incompatible with
   existing import-stripping VM harnesses (78 failures including cascades).
   Removed the unnecessary re-export, loaded the canonical module in the lifecycle
   harness, and ran `npm run build:pages`. No tests were removed or stubbed out.
6. Focused final unit command:
   `node --test tests/unit/pages-publication-preflight.test.mjs tests/unit/pages-editor-review.test.mjs tests/unit/pages-editor-lifecycle.test.mjs tests/unit/pages-button.test.mjs tests/unit/pages-composition.test.mjs`
   **99 tests passed, 0 failed, 0 skipped**, output in
   `pages-task4-unit-final-20261116b.log`.
7. `node tests/visual/check-pages-controls.mjs review`, final output variable
   `PAGES_CONTROLS_OUTPUT=.../pages-task4-final-20261116d`: **exit 0**, four widths,
   zero page errors and zero publication POSTs. Prior green/final directories
   remain preserved (`...final-20261116a/b/c`). Final run additionally covers the
   empty FAQ add-action target found during inline review.
8. `node tests/visual/check-pages-publication-preflight.mjs`,
   `PREFLIGHT_VISUAL_OUTPUT=.../pages-task4-preflight-final-20261116b`:
   **PASS 2 scenario groups**; real FAQ-only publication/read and incomplete v3
   blocking retained. Earlier `...preflight-20261116a` also passed.
9. `node tests/visual/check-pages-review.mjs`,
   `REVIEW_VISUAL_OUTPUT=.../pages-task4-review-final-20261116c`:
   **PASS 6 scenario groups**; output log
   `pages-task4-review-final-20261116c.log`. Includes save/retry, exact payload,
   stale/CAS conflict, publication COMMIT with lost ACK, catalogue changes during
   uncertain retry, readonly publisher, personal checks and permission behavior.
   Earlier `...review-20261116a` and `...review-final-20261116b` also passed.
10. `node tests/visual/check-pages-review.mjs --strict-reference-geometry`,
    `REVIEW_VISUAL_OUTPUT=.../pages-task4-review-strict-20261116a`:
    **intentional exit 1: dialog.y 25 != 190**. Historical assertion remains exact;
    this is not reported as a fidelity PASS. Original PNG SHA validation executes
    first and passed.
11. `node tests/visual/check-pages-controls.mjs save`,
    `PAGES_CONTROLS_OUTPUT=.../pages-task4-save-regression-20261116a`:
    **exit 0**, all four widths/permission cases, zero page errors. Stable Save,
    real ACK/replay, dirty newer edits, lost ACK and CAS safeguards retained.
12. Final `npm run verify`, with PGlite/FFmpeg variables set, output
    `pages-task4-verify-final-20261116d.log`: **verify: ok; 1210 tests, 1207 passed,
    0 failed, 3 skipped**, plus syntax, security and Compose checks. Earlier fixed
    complete runs also passed. Skips remain the existing Linux/external-reference
    checks; final verify did not set the external PNG directory, while broad
    review separately validated its original SHA.
13. `git diff --check`: exit 0; localized diff reviewed. No hidden elements, relaxed
    publication assertions, fabricated ACKs or updated source images to make tests
    pass. New geometry contract assertions accompany the explicit classification.

## Evidence and what it proves

`pages-task4-final-20261116d/review.json` records all widths, modal bounds, SQL
version 4 after four explicit saves, zero publication POSTs, and zero page errors.
For each width, `*-issues.png` and `*-long-audience.png` show the actual template
review and long synthetic cargo catalogue. Visually inspected 320px long-cargo
and desktop issue captures; checkbox indicators, scrolling and retained actions
are visible, not covered by another overlay.

The scenario creates a fresh real Guia template and never replaces the opened
document with a fixture. UI performs audience correction, FAQ answer editing,
audio field editing and title correction; SQL proves edits are not autosaved and
are stored only after Save. It retains every original EditorView through those
routes. A test-only source observation hook then makes targeted state transactions
to reproduce removal between render/click, and empty FAQ; these are explicit race
tests, not claims of normal pointer authorship or fixture replacement. Removed
target keeps the message/modal; empty FAQ focuses Adicionar pergunta and Enter
creates its actual question control. SQL/publication pointer remains unchanged.

At 1600×1160 the historical 580×670 dialog at y190 becomes a centered 580×1110
dialog at y25 for the actual long issue content. Text controls become 44px rather
than 37px; footer controls become 44px rather than 36px. Insets become 24px and
group spacing 16px. These are intentional approved accessibility/content changes,
not pixel fidelity. `results.json` in the broad review directory records each
source/actual metric. Original horizontal dialog frame and new exact layout
assertions still run; strict mode fails honestly at the old vertical geometry.

## Limits, review and handoff

Only loopback Express/SQL in disposable serialized PGlite, synthetic identities,
locally installed Chrome/Playwright and axe are evidenced. No native PostgreSQL 16
concurrency/restore, Firebase sign-in, Nginx, production deployment, physical mobile
keyboard/IME/touch, live YouTube or six-board final acceptance is claimed. Existing
Node manifests still run Node 24; new source uses no Node >18-specific APIs.

Inline review found and corrected the empty-FAQ action resolving to block chrome;
the final browser runner explicitly guards that case. No remaining blocker found.
Parent should review the new module/interface and the intentional strict-geometry
distinction. The old root `task-4-report.md` and unrelated untracked screenshots
were preserved; this report lives alongside the current Task 1–3 reports.

Commit subject: `fix(pages): expose actionable publication issues`.
Base: `ec87971`; resulting hash is supplied in the completion response.

## Review follow-up — FAQ correction toolbar identity

Parent review identified an Important issue in `onIssue`: `select(blockId)` built
formatting controls before `activeItemId` changed. Because these controls capture
`activeEditor()`, switching from answer A to Correct B could leave the controls
bound to A; the subsequent focus handler saw the already-assigned B identity and
did not rebuild. Entering FAQ from another block could omit its formatting controls.

Fixed locally in the correction callback, without changing shared controllers:
close the history group when block/item identity changes, establish both
`activeId` and `activeItemId`, then call the existing `select()` once. Toolbar
creation now sees the complete intended identity. No PM view is recreated and no
publication/session/retry/permission logic changes.

`pages-editor-review-controls.mjs` now runs an independent real-template regression
at 320/390/768/1366px before each existing scenario. A small helper reuses the
existing source-observation hook; it does not replace the document or inject edits.
The browser focuses answer A, opens review, corrects empty answer B, immediately
clicks Negrito (without another caret interaction), and types. It then selects an
unrelated rich-text block, corrects empty answer A, immediately clicks Itálico and
types. Both paths assert the focused editor, compare the entire schema JSON to an
independently constructed expected document, preserve all original PM view
identities, explicitly Save, and compare actual SQL JSON. Thus the other answer,
all unrelated blocks/metadata and schema version must remain unchanged. Existing
issue/race/axe/geometry coverage is unchanged. Per-width evidence includes
`*-correction-formatting.png`; `review.json` records both regression and original
scenario results.

Using the environment variables documented above and fresh output directories:

- **Red**, before product fix:
  `PAGES_CONTROLS_OUTPUT=.../pages-task4-format-red-20261116a`;
  `node tests/visual/check-pages-controls.mjs review` exited 1 at 320px:
  `A→Correct B→immediate bold edits only B, including schema JSON`.
  The diff showed the strong-marked “Resposta B 320” in **A**, with **B still empty**.
  This is the reported product failure, not a harness/setup failure.
- **Green**, after the localized fix:
  `PAGES_CONTROLS_OUTPUT=.../pages-task4-format-green-20261116a`;
  same command exited 0, both formatting routes and original issue coverage at all
  four widths, zero page errors. No assertions or historical source checks weakened.
- `node tests/visual/check-pages-review.mjs`,
  `REVIEW_VISUAL_OUTPUT=.../pages-task4-format-review-20261116a`: **PASS 6 groups**.
  Output log: `pages-task4-format-review-20261116a.log`; intentional geometry
  differences remain classified and strict source assertions remain available.
- `node tests/visual/check-pages-publication-preflight.mjs`,
  `PREFLIGHT_VISUAL_OUTPUT=.../pages-task4-format-preflight-20261116a`:
  **PASS 2 groups**.
- Same five-file focused unit command from step 6 above: **99 passed, 0 failed,
  0 skipped**; `pages-task4-format-units-20261116a.log`.
- `npm run verify`: **verify: ok; 1210 tests, 1207 passed, 0 failed, 3 existing
  skips**, plus syntax/security/Compose;
  `pages-task4-format-verify-20261116a.log`.
- Localized follow-up diff reviewed inline; `git diff --check` passed before commit.
  No additional agents, backend, dependencies, production or broad controller work.

Follow-up base: `8ececf9`. Follow-up commit hash is supplied in the completion
response. No remaining blocker found for this review item; prior evidence limits
still apply.
