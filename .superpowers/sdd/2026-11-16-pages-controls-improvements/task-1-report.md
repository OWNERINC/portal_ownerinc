# Task 1 implementation report

## Outcome

Implemented only Task 1 on base `6008528c57fcb685047ea2c275237fd2105b3ef6`.
Transient text actions now have readable full-width rows (at least 100 × 44 CSS
px), rather than inheriting the 30 px desktop icon width. Preview, More actions
and More text options share dismissal and exclusivity. Existing FAQ, audience,
advanced settings, panels and task dialogs retain their separate ownership.

No production access, API/migration/grant/cron/Nginx/deploy changes, dependencies,
autosave, document migrations, or real-content substitutions were made. Historical
untracked screenshots were left untouched. No subagents were spawned.

## Interfaces and changed files

- `public/pages/editor-menus.js`: new `createEditorMenus({page})` returning
  `register(details) -> unregister`, `closeAll({restoreFocus = false} = {})`,
  `dispose()`. Registers only explicit transient details; listens to pointerdown
  and keydown in capture phase, plus each registered details' click/toggle.
  Outside pointerdown never prevents default or moves focus. Escape consumes
  one menu layer, focuses summary, ignores IME/keyCode 229 and higher open dialogs.
  Unregister and page disposal close and remove owned listeners.
- `public/pages/editor.js`: controller ownership, registration/retirement of text
  and preview menus; explicit compact-button class only for actual icon controls.
- `public/pages/editor-workspace.js`: additional `menus` option, overflow
  registration/disposal, workspace Escape honors consumed/composing events.
- `public/css/pages-editor-v2.css`: replace conflicting blanket icon sizing;
  textual rows, scrolling/bounds, visible summary focus, real 44 px menu summary
  targets and removal of overlapping formatting-button pseudo targets. Slightly
  wider desktop formatting toolbar intentionally accommodates real icon targets.
- `tests/unit/pages-editor-menus.test.mjs`: controller ownership, one-open policy,
  unregister/dispose, IME/dialog priority, focus and non-cancelling outside clicks.
- `tests/unit/pages-editor-lifecycle.test.mjs`: load the real new controller into
  the existing VM integration harness, without stubbing it or dropping coverage.
- `tests/visual/pages-editor-controls.mjs`: small reusable incremental `menus`
  runner, disposable PGlite database, real local API/browser/editor, network denied
  outside localhost. Does not import the broad ignored historical audit runner.
- `docs/architecture/pages.md`: controller contract and local runner invocation.
- This report.

## TDD: red, implementation, green

1. Added tests and the browser runner before product changes.
   `node --test tests/unit/pages-editor-menus.test.mjs tests/unit/pages-editor-focus.test.mjs`
   initially exited 1: three new cases failed because the module did not exist;
   three existing focus cases passed.
2. Ran `node tests/visual/pages-editor-controls.mjs menus` with PGlite/Playwright
   module paths provided in the task and
   `PAGES_CONTROLS_OUTPUT=C:/Users/Criação/AppData/Local/Temp/opencode/pages-task1-red-20261116a`.
   It exited 1 on the actual product defect: `menus 1366: textual action width 30`.
   Evidence: `1366-text-menu.png`, `menus.json` in that directory.
3. Implemented controller and localized CSS/integration. Intermediate iterations
   found a missing `isConnected` field in the fake summary and the existing
   mobile command behavior returning to Conteúdo. Fixed the fake DOM shape;
   runner explicitly reopens Estilo after commands. No element was hidden and
   no assertion/viewport coverage was removed to pass.
4. Final focused command above: **6 passed, 0 failed, 0 skipped**.
5. Final browser command above, with output directory
   `C:/Users/Criação/AppData/Local/Temp/opencode/pages-task1-final-20261116a`:
   **exit 0, four viewports passed, zero page errors**. Covers actual numbered
   and unordered list commands, remove list, undo restoring ordered-list DOM,
   unchanged text, Escape focus, text→Preview exclusivity, Preview→More actions
   on phones, outside dismissal and retained `.ProseMirror` node across resize.
   Desktop and mobile screenshots were read visually during implementation.
   Measured numbered-list targets: 262×44 (1366), 334×44 (390), 264×44 (320),
   712×44 (768). Preview popup bounds are also asserted at each width.
6. First `npm run verify` exposed 48 lifecycle failures caused by the VM harness
   stripping imports without loading the new controller. Added its real module
   to the harness; reran the entire verification, not only the failures.
7. Final `npm run verify`: **verify: ok; 1200 tests, 1197 passed, 0 failed,
   3 skipped**, including syntax/security/Compose checks. Supplied PGlite,
   Playwright, Axe and resolved ffmpeg/ffprobe environment paths. Full log:
   `C:/Users/Criação/AppData/Local/Temp/opencode/pages-task1-final-20261116a/verify.log`.
8. `git diff --check`: exit 0. Reviewed localized diff. No independent reviewer
   was spawned because the task explicitly prohibits additional subagents.

## Browser evidence

All final artifacts are under the unique approved Temp directory above:

- `menus.json`: four passing results, target rectangles and empty error list.
- `{1366,390,320,768}-text-menu.png`: real open formatting controls.
- `{1366,390,320,768}-preview-menu.png`: preview popup.
- `{390,320}-actions-menu.png`: phone More actions popup.
- `verify.log`: complete successful verification.

Only synthetic newly created documents were used in the local harness. No claims
are made about production authentication, real content, or production persistence.

## Skips, limitations and concerns

- Existing platform skips: Linux flock semantics and Linux symlink escape checks
  are not executable evidence on Windows. They remain Linux acceptance gates.
- `PAGES_REFERENCE_DIR` was not supplied; six external PNG hash/dimension fidelity
  verification was skipped. No replacement goldens were generated, and no false
  equality to old reference boards is claimed. Toolbar/row dimensions intentionally
  differ to satisfy readable text and 44 px targets.
- This task does not fix unrelated inspector/mobile status and save placement
  findings reserved for later approved tasks. Text command focus still returns
  mobile properties to Conteúdo as in the existing editor.
- No dedicated full-page Axe audit was added to the scoped menus case; this report
  claims browser interaction/geometry evidence, not a new global accessibility audit.
- No task-specific blockers remain. Parent session should perform the requested
  independent review before integration.

## Commit

Localized implementation commit message:
`fix(pages): make editor menus readable and dismissible`.
The hash is supplied in the subagent completion response (this report is included
in that same commit).
