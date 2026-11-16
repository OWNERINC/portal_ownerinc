# Task 2 implementation report

## Outcome and scope

Implemented Task 2 only on base `839d1ac` (Task 1 preserved). Structure controls
work in the desktop rail and compact dialog. Expanded Posição/actions occupy a
separate full-width row; the handle is a real 44 × 44 CSS px target. Organizing
state follows the nav when it is reparented outside the editor root.

No production, existing content, backend, migration, grant, cron, Nginx, deploy,
dependency, implicit document conversion or autosave changes. Historical untracked
screenshots and the six references were not overwritten. No subagents spawned.
The approved brief was read, not the entire plan. README, product brief and Pages
architecture were read; uncodixfy and brainstorming guidance were loaded with the
existing approved UX/plan as the design input. Review was performed inline because
the assignment explicitly prohibits additional subagents; parent review remains
appropriate before integration.

## Files and interfaces

- `public/pages/editor-workspace.js`: synchronize `data-organizing` on root/nav;
  add `pages-v2-section-position` and `pages-v2-section-actions`. Preserve
  `onReorderSection({sectionId,beforeSectionId})`, UUIDs, sorting and focus callbacks,
  selection and authoritative editor state/history. No new EditorViews or state.
- `public/css/pages-editor-v2.css`: replace conflicting structure rules with a
  shared rail/dialog layout, 44 px targets, wrapping labels/actions, visible focus;
  remove absolute 32 px handle and obsolete hit-extension pseudo-elements for
  handle/add-section. Those pseudo-elements are unnecessary with real targets;
  the handle's old absolute pseudo-element intercepted neighboring desktop controls.
  Existing organizing disclosure behavior remains; controls are not hidden as a
  clipping workaround. Existing tokens/colors retained.
- `tests/unit/pages-workspace-controls.test.mjs`: two real-workspace tests using
  the existing fake DOM, covering organizing reparent/rebuild, UUID reorder,
  boundaries, permissions, invalid-drop restoration and keyboard focus.
- `tests/visual/pages-editor-controls.mjs`: keep Task 1 menus case, add `structure`
  dispatch and scenario-specific result JSON.
- `tests/visual/pages-editor-structure.mjs`: incremental browser case using an
  actual newly created Guia template, real local API and disposable PGlite SQL.
  Never replaces the open document with a fixture. Tests all five sections at
  320/390/768/1366, opens every Posição, checks overflow, button/summary bounds,
  real targets and center hit-testing. Exercises organizing on/off in the dialog,
  Subir/Descer, first/last limits, Alt+arrows, pointer drag/Escape cancellation,
  selection/focus, explicit save, persisted order, local undo, retained PM nodes/
  view descriptors, resize and Escape return to Blocos. External traffic denied
  by the existing browser helper.
- `tests/visual/check-pages-controls.mjs`: stable CLI entry point importing the
  incremental runner; Task 1's direct invocation remains compatible.
- `docs/architecture/pages.md`: matching structure contract and runner command.
- This report.

## Reproduction environment and commands

PowerShell environment (external modules only, no installs):

```powershell
$env:PGLITE_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js'
$env:PLAYWRIGHT_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/playwright/index.mjs'
$env:AXE_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/@axe-core/playwright/dist/index.mjs'
$env:FFMPEG_PATH=(Get-Command ffmpeg).Source
$env:FFPROBE_PATH=(Get-Command ffprobe).Source
```

1. Red unit command:
   `node --test tests/unit/pages-workspace-controls.test.mjs tests/unit/pages-editor-focus.test.mjs`
   After correcting the test DOM's matchMedia/primary-action setup, **8 passed,
   2 failed** on product assertions: missing nav organizing state and missing
   position class. The first harness attempt failed on fake media shape, not the
   product; it is not counted as defect evidence.
2. Red browser command:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task2-red-20261116c'`
   then `node tests/visual/pages-editor-controls.mjs structure`.
   **Exit 1: `structure 320: horizontal clipping 318 > 280`**. Screenshot in that
   directory. Earlier `red-20261116a`/`red-20261116b` runs also failed on the 32 px
   Posição target. Explicit overflow assertion was added because automatic browser
   scrolling could otherwise mask the overflow by horizontally shifting content.
3. Intermediate browser runs (`green-20261116a`/`green-20261116b`) exposed an incorrect
   test assumption that selecting a section opens the inspector, and the actual
   desktop handle pseudo-element intercepting the organize button. Corrected the
   assumption (selection intentionally passes `false`) and removed the intercepting
   pseudo-element. Fake DOM aria-label queries containing spaces were also changed
   to explicit attribute comparisons, since that harness does not parse them.
   No viewport or control coverage was removed.
4. Final focused command:
   `node --test tests/unit/pages-workspace-controls.test.mjs tests/unit/pages-editor-focus.test.mjs tests/unit/pages-editor-lifecycle.test.mjs`
   **58 passed, 0 failed, 0 skipped**. Existing lifecycle includes layout drag
   guards, PM retention, permissions, IME and single-timeline tests.
5. Final structure command:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task2-final-20261116c'`
   then `node tests/visual/check-pages-controls.mjs structure`.
   **Exit 0; all four viewports passed, zero page errors**. The final iteration
   includes actual center hit-tests to catch neighboring pseudo-element interception.
6. Task 1 regression:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task2-menus-20261116a'`
   then `node tests/visual/check-pages-controls.mjs menus`.
   **Exit 0; four viewports passed, zero page errors**.
7. Historical broad workspace command:
   `$env:WORKSPACE_VISUAL_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task2-workspace-20261116a'`
   then `node tests/visual/check-pages-workspace.mjs`.
   **Exit 1 at line 42**, which requires invisible hit extensions above compact
   buttons. This is intentionally not asserted as passing: the approved controls
   design uses real 44 px targets and removes obsolete pseudo-targets. The broad
   runner was left unchanged; later checks in that runner did not execute. The
   incremental case independently verifies the changed structure's targets,
   hit-testing, behavior and SQL. No false equality to old reference boards.
8. `npm run verify` (twice after implementation, latest after final code/tests):
   **verify: ok; 1202 tests, 1199 passed, 0 failed, 3 skipped**, plus syntax,
   security and Compose checks. Latest full log:
   `C:/Users/Criação/AppData/Local/Temp/opencode/pages-task2-final-20261116b/verify-final.log`.
9. `git diff --check`: exit 0 before commit. Localized diff reviewed.

## Evidence and limits

Final structure artifacts are in `pages-task2-final-20261116c` under the approved
Temp root: `structure.json`, `{320,390,768,1366}-structure.png` and per-section
`*-structure-{0,1,2,3,4}.png`. Screenshots were visually reviewed, including compact
and desktop. The JSON records measured rectangles and saved/undo UUID order.
At 320 px, Capa handle is 44 × 44, summary 232 × 44, and each move button 112 × 44.
Earlier successful artifacts are preserved in `final-20261116a`/`final-20261116b`.
Task 1 regression artifacts and complete verify logs are in the directories above.

Only newly created synthetic local documents/identities/database were used. SQL
confirms no autosave before the command, reordered head after explicit save, and
unchanged persisted head after undo. This is serialized PGlite/browser evidence,
not native PostgreSQL 16 concurrency, Firebase, Nginx or production acceptance.
No dedicated global Axe audit or physical touch/IME test was added. The three
verify skips remain platform/reference gates (Windows cannot prove Linux flock/
symlink behavior; no external six-reference directory was supplied). Existing
runtime is Node 24 per manifest; changed code introduces no Node-18-only mismatch.
Generic modal scrolling/header behavior and future inspector/save tasks are not
redesigned here.

## Commit

`fix(pages): keep section actions inside the structure panel`

The completion response supplies the resulting hash. Parent should review the
intentional historical workspace assertion divergence before integration; this
report does not claim the broad visual suite is green.
