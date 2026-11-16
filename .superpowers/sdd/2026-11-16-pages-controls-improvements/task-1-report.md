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

## Integration follow-up — measured toolbar clearance (base `91b3c16`)

### Findings and bounded fix

Reproduced the Important functional regression reported after Task 2, preserving
the reviewed structure changes. The toolbar border-box is **52 px** (44 px
controls plus padding/border), but `measureViewport()` still reserved space using
**44 px**. At 50% this under-reserved the scaled paper and produced the reported
**1.4921875 px overlap**. This is a product failure, separate from the intentional
412-versus-329 px toolbar width/reference difference.

Simply replacing 44 with 52 plus the old gap needlessly increased the 100% intro
height by 8 px and failed the unchanged original content-anchor assertion.
Instead the fix retains the existing baseline whenever sufficient and reserves:

`max(44 / scale + 28, (measuredToolbarHeight + 4) / scale + 16)`

The second term accounts for the actual unscaled border-box, its 16-paper-pixel
anchor and a minimum 4-physical-pixel gap. This fixes low zoom without moving the
established 100% paper anchors. The existing viewport ResizeObserver also observes
the current toolbar, unobserves retired toolbars and disconnects on disposal, so
reflow/changed metrics are not frozen at mount time. No document/PM content or
EditorView ownership changed.

Continuing the full runner found a second direct integration regression at
1366/desktop/50%: the wider toolbar extends across a neighboring card and intercepted
the real cross-column drag destination. During a layout drag only, the visible
toolbar now yields pointer hit-testing (`pointer-events: none`). It is not hidden,
resized or removed; drop completion/failure and workspace teardown reset the flag.
Block and section sorting share the same scoped `setLayoutDragging` owner.

The runner's preparatory hover now targets the actual editable heading instead
of the whole section's center (which can legitimately be reserved toolbar area).
No force-click, synthetic Sortable callback, hidden element, reduced viewport/zoom
loop or weakened clearance/drop assertion was used. Added assertions verify the
toolbar stays visible, opaque and 52 px high while yielding drag hit-testing;
the reset flag; and **all** original PM nodes and view descriptors after each
drop/undo/zoom/selection cycle. Existing strict geometry and content-anchor checks
remain unchanged. Card clearance rectangles and low-zoom screenshots were added.

### Changed files in integration commit

- `public/pages/editor-workspace.js`: bounded measured reservation, current-toolbar
  observation/unobservation; no change to Task 2 structure ownership or commands.
- `public/pages/editor.js`: central scoped layout-drag state mirrored to root.
- `public/css/pages-editor-v2.css`: only the drag-time pointer-events rule.
- `tests/unit/pages-workspace-controls.test.mjs`: regression across five zooms,
  both device modes, 52/96 px metrics; asynchronous 120 px metric change and
  observer retirement/disposal coverage.
- `tests/unit/pages-editor-lifecycle.test.mjs`: block-drag flag/reset assertions.
- `tests/visual/check-pages-workspace.mjs`: precise content hover, stronger
  visible-drag/PM retention assertions and additional evidence; no removed checks.
- `docs/architecture/pages.md`: measured clearance/drag hit-testing contract.
- This appended integration report.

### Red/green commands, output and evidence

Environment uses the same external `PGLITE_MODULE_PATH`, `PLAYWRIGHT_MODULE_PATH`,
`AXE_MODULE_PATH` and resolved `FFMPEG_PATH`/`FFPROBE_PATH` listed in the Task 2
report. Every evidence directory below is a new directory under:
`C:/Users/Criação/AppData/Local/Temp/opencode/`.

1. Added unit regression before product changes:
   `node --test tests/unit/pages-workspace-controls.test.mjs` — **7 passed,
   1 failed**, `desktop/50: measured 52px toolbar`, **116 != 132** (initial
   exact measured-height formula expectation, subsequently bounded to preserve
   existing content geometry).
2. Set `WORKSPACE_VISUAL_OUTPUT=.../pages-task1-integration-red-20261116a`, ran
   `node tests/visual/check-pages-workspace.mjs` — **exit 1**, unchanged
   `unscaled toolbar never covers the text/caret`. `results.json` and
   `failed-caret-1600-desktop-50.png` preserve actual overlap evidence.
3. Intermediate `...green-20261116a` — naive measured-height substitution failed
   unchanged `intro bottom: expected 555 ±2, got 562.609375`; bounded reservation
   preserves that original assertion rather than changing its tolerance.
4. `...green-20261116b` found whole-section center hover intercepted by the real
   toolbar. `...green-20261116c` then reached the actual cross-column destination
   regression: **Drop failed at 50%**, with pointerup on a formatting button.
   `failed-drop-50.png` was visually reviewed; its `results.json` includes real
   pointer/Sortable events. Added drag-state unit assertion before its fix:
   `node --test --test-name-pattern="block drag uses pointer fallback" tests/unit/pages-editor-lifecycle.test.mjs`
   — **1 failed**, missing `data-layout-dragging=true`.
5. After scoped drag fix, `...green-20261116d` — **PASS 15 workspace scenarios**.
6. Final focused command:
   `node --test tests/unit/pages-workspace-controls.test.mjs tests/unit/pages-editor-focus.test.mjs tests/unit/pages-editor-lifecycle.test.mjs`
   — **59 passed, 0 failed, 0 skipped**.
7. Final functional command, after stronger browser assertions were added:
   `WORKSPACE_VISUAL_OUTPUT=.../pages-task1-integration-final-20261116a`
   and `node tests/visual/check-pages-workspace.mjs` — **exit 0, PASS 15 workspace
   scenarios, zero page errors**. All 20 1600/1366 × desktop/mobile ×
   50/75/100/125/150 combinations complete actual drop/undo/caret checks. Minimum
   measured intro clearance **4.5078125 px**, card clearance **19.5078125 px**.
   All later FAQ, guarded model creation, committed lost-ACK retry, navigation
   failure/reuse, explicit-save races, Portal exit/Back, touch, writer-off,
   review-only and exact v2 JSON/PM retention scenarios execute and pass.
8. Strict-reference command:
   `WORKSPACE_VISUAL_OUTPUT=.../pages-task1-integration-strict-20261116a`
   and `node tests/visual/check-pages-workspace.mjs --strict-reference-geometry`
   — **exit 1**, intentionally retained **412 != 329** at the strict source
   width assertion. This is NOT a strict-reference pass or replacement golden.
   Final functional JSON separately records all 20 width differences.
9. `PAGES_CONTROLS_OUTPUT=.../pages-task1-integration-menus-20261116a`
   with `node tests/visual/check-pages-controls.mjs menus` — **exit 0**;
   `PAGES_CONTROLS_OUTPUT=.../pages-task1-integration-structure-20261116a`
   with `node tests/visual/check-pages-controls.mjs structure` — **exit 0**.
   Both retain all four viewports and zero page errors. Latest Task 2 behaviors
   and SQL save/order/undo evidence remain green.
10. `npm run verify` — **verify: ok; 1203 tests, 1200 passed, 0 failed, 3 existing
    skips**, syntax/security/Compose complete. Log:
    `.../pages-task1-integration-final-20261116a/verify.log`.
11. `git diff --check` — **exit 0**. Reviewed localized diff; commit only these
    integration changes, preserving Task 2 and historical untracked screenshots.

Final functional evidence includes `results.json`, four
`caret-clearance-{1600,1366}-{desktop,mobile}-50.png` captures (1366/desktop/50
visually reviewed), the existing desktop/style/insert captures and
`legacy-v2-mobile390-in-desktop1600.png`. No source reference images changed.

### Remaining limits and integration status

No task-specific functional blocker remains. Strict 329 px reference geometry
continues to fail intentionally. The three existing verify skips are Linux flock,
Linux symlink semantics and missing `PAGES_REFERENCE_DIR`; no Linux/external-PNG
acceptance is claimed. Only disposable local API/PGlite/browser fixtures were
used; no backend changes, production access, new dependencies or subagents.
The integration commit hash is supplied in the completion response.
