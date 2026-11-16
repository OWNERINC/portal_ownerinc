# Task 3 implementation report

## Outcome and scope

Implemented Task 3 only on `309aeac` (measured toolbar clearance base). Save is a
single persistent chrome action on desktop/tablet/phone, not an action relocated
by dirty/pending or put inside More actions. Status remains visible with the lower
sheet open, including a short viewport. Publish is genuinely disabled-looking
and has a visible, associated reason. Existing persistence and command controllers
remain authoritative.

Read the task brief/approved UX, README, product brief, Pages architecture and prior
task report. Did not read the whole plan. Loaded uncodixfy and brainstorming;
the supplied approved design is the design input, not a new design proposal.
Loaded review guidance and reviewed the localized diff inline, because this
assignment explicitly prohibits spawning additional subagents. Parent review
remains appropriate before integration.

No backend, database schema, migrations, grants, cron, Nginx, deploy, dependency,
production, real-content or implicit document conversion changes. No Docker
services started. No autosave or publication changes. Historical screenshots and
the six reference boards were not changed or overwritten. Evidence is exclusively
in new directories under the approved Temp root.

## Files and interfaces

- `public/pages/editor.js`: remove the dirty-conditioned relocation from
  `update()`. Build one `.pages-operation-bar` containing existing status and
  `.pages-primary-actions`, with the existing Save node followed by Publish.
  Keep reload/archive in Page properties. `update()` changes availability/text,
  not location. Avoid rewriting the live status text for every keystroke when
  its message is unchanged. Pending failures explicitly say the save is not
  confirmed, retry reconciles the submitted revision, and later edits are not
  saved. Conflict explicitly preserves local changes. Publish has
  `aria-describedby="pages-publish-reason"` and a visible reason while disabled.
- `public/pages/editor-workspace.js`: no reparenting Save/Publish into More actions
  or the phone toolbar on breakpoint changes. Preview still moves to the existing
  phone toolbar; secondary editor controls still use More actions. Remove the
  obsolete primary click handler which forcibly focused More actions. The existing
  owned ResizeObserver also observes header height, setting
  `--pages-chrome-height` so compact sheet max-height leaves chrome clearance.
  Existing observer disconnect/disposal is retained. No new EditorViews.
- `public/css/pages-editor-v2.css`: use existing palette/tokens. Sticky header
  retains layout space, with a wrapping operation group/status on phones. Reserve
  the Save slot even when its existing controller changes its label to Salvo.
  Publish has a real 44 px target, not an invisible extension. Remove old
  first-child coloring, fixed 36 px Publish height, hidden phone status and other
  conflicting rules in the touched area. Explicit disabled/disabled-hover colors
  are scoped to operation buttons and do not become primary after parent changes.
  A `position:relative` declaration on reparented view-tool buttons confines their
  existing pseudo-targets: previously Refazer's pseudo-target could intercept
  Propriedades in the phone overflow. No general inspector form redesign.
- `tests/unit/pages-editor-lifecycle.test.mjs`: update old location assertions
  without dropping controls; add 3 tests for stable parent through all save states,
  old ACK/new edits, retry snapshot, conflict, no duplicate calls, retained views,
  review-only/disabled-writer permissions, and stale ACK across visit replacement.
  Harness accepts explicit capabilities for these tests.
- `tests/visual/pages-editor-controls.mjs`: add the incremental `save` scenario;
  `tests/visual/check-pages-controls.mjs` remains the stable importing CLI entry.
- `tests/visual/pages-editor-save.mjs`: real newly created Comunicado templates,
  HTTP API and disposable SQL. Never replaces an open document with a fixture.
  Cover 320/390/768/1366, Page properties open, real pointer access, stable action
  slot, visible status/reason, disabled hover, busy and duplicate activation,
  title edit during held save, clean ACK, 503, same-payload/key retry, lost ACK
  after a real API COMMIT, replay without a new revision, Mod+S from the title,
  competing real server save/CAS conflict, local edits preserved, pane/document
  scrolling, 480 px short phone viewport, breakpoint retention of Save parent and
  PM view identity, author without Publish, publisher read-only and rejected
  non-author write. Only transport failure/delay and synthetic identity verification
  are injected; a fulfilled fake ACK is never persistence evidence.
- `tests/visual/check-pages-workspace.mjs`: replace the now-obsolete invisible
  Publish extension assertion with real 44 px bounds and center/four-inset-corner
  hit-testing; add the same Save target coverage. All other source geometry and
  functional checks remain active, including strict reference mode.
- `docs/architecture/pages.md`: matching command, chrome/status and retry contract.
- This report.

### Preserved interfaces and semantics

`state.save(api)` and `createPageButton` are unchanged. The existing adapter still
requires an actual API acknowledgement and checks that the acknowledged revision
is current before showing Salvo. There is exactly one Save command node. The
existing button busy lock, state blocked guard, immutable pending snapshot/key,
CAS, permissions, review session uncertainty, upload guards, Mod+S, leave guards,
and per-visit disposal remain in place. Save never publishes. Concluir edição
still only closes the panel. No v1/v2/v3 migration occurs on opening/resize.

## Reproduction environment

PowerShell, external modules already available; no installs:

```powershell
$env:PGLITE_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/consent-db-tools/node_modules/@electric-sql/pglite/dist/index.js'
$env:PLAYWRIGHT_MODULE_PATH='C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/playwright/index.mjs'
$env:FFMPEG_PATH=(Get-Command ffmpeg).Source
$env:FFPROBE_PATH=(Get-Command ffprobe).Source
```

All artifact directory names below are relative to
`C:/Users/Criação/AppData/Local/Temp/opencode/`. The runner requires a **new**
`PAGES_CONTROLS_OUTPUT` directory and refuses to reuse an existing directory.

## Red → green and verification

1. Initial red command, unchanged product:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-red-20261116a'`
   then `node tests/visual/check-pages-controls.mjs save`.
   Exit 1. At 320/390 pointer access to Propriedades timed out because reparented
   Refazer intercepted it. The first draft also used the new operation-bar
   selector before implementation at wider sizes, so those selector failures
   are harness setup, not product evidence.
2. Second red, still unchanged product: `.../pages-task3-red-20261116b`.
   Temporarily used the real keyboard path (focus Propriedades, Enter) at 320/390
   to reach the panel despite that independent pointer blocker. The temporary
   `PAGES_SAVE_RED_KEYBOARD=true` branch was subsequently removed; final coverage
   uses normal pointer access everywhere. Both 320 and 390 failed the explicit
   assertion **Save reachable with sheet open, without More actions: false**.
   768 also lacked the visible Publish reason, and 1366 failed the real 44 px
   action target. New red screenshots/results remain preserved.
3. First green (`...green-20261116a`) reached all real persistence/retry checks
   but exposed a test assumption: after a disabled Save loses browser focus,
   Mod+S on the body does not use the existing root-scoped shortcut handler.
   The scenario now explicitly focuses the editable title before the shortcut,
   matching the supported existing contract. No shortcut listener was widened.
   `...green-20261116b` passed all four widths.
4. Initial permission extension expected a ProseMirror in a review-only visit;
   that is intentionally absent. Replaced that setup wait with the real header
   wait, retaining disabled-field/no-Save/API-denial assertions. This was not a
   product failure. Added fixed Save width after checking the confirmed-label
   slot and reserved the reason line height to eliminate a subpixel row shift.
5. Focused unit command:
   `node --test tests/unit/pages-state.test.mjs tests/unit/pages-button.test.mjs tests/unit/pages-editor-lifecycle.test.mjs tests/unit/pages-workspace-controls.test.mjs`
   **83 passed, 0 failed, 0 skipped**. One earlier run failed the preexisting
   assertion that Save belongs in secondary actions; it was replaced with the
   approved new chrome location and complete button counts.
6. Final save command:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-final-20261116e'`
   then `node tests/visual/check-pages-controls.mjs save`.
   **Exit 0; four widths plus author/publisher permission cases, zero page errors.**
   9 save transport attempts per width; SQL confirms COMMIT before lost ACK,
   revision count unchanged on replay, correct newer document only after its own
   explicit save, and competing content preserved on real 409.
7. Final menu regression:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-menus-20261116b'`
   then `node tests/visual/check-pages-controls.mjs menus`.
   **Exit 0; four widths, zero page errors.**
8. Final structure regression:
   `$env:PAGES_CONTROLS_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-structure-20261116b'`
   then `node tests/visual/check-pages-controls.mjs structure`.
   **Exit 0; four widths, zero page errors; SQL/order/explicit save/undo retained.**
9. Broad functional workspace:
   `$env:WORKSPACE_VISUAL_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-workspace-20261116d'`
   then `node tests/visual/check-pages-workspace.mjs`.
   **Exit 0; PASS 15 workspace scenarios.** Earlier `...workspace-20261116a` and
   `...workspace-20261116b` also passed. A parallel-loaded run in
   `...workspace-20261116c` failed the unchanged style-panel source assertion:
   x=350 instead of 360, despite inline `--panel-left:360px`; header/tools/paper
   exact assertions had passed. Serial rerun on identical code passed. This
   intermittent panel measurement was not exempted, hidden, or relaxed; failed
   artifacts remain available. Its cause is unconfirmed and outside Save logic.
10. Strict historical geometry:
    `$env:WORKSPACE_VISUAL_OUTPUT='C:/Users/Criação/AppData/Local/Temp/opencode/pages-task3-workspace-strict-20261116a'`
    then `node tests/visual/check-pages-workspace.mjs --strict-reference-geometry`.
    **Exit 1 intentionally at existing toolbar 412 != source 329 px.** Not a
    fidelity pass. Actual-target checks for Save/Publish executed first.
11. Final complete command, external PGlite/FFmpeg variables above set:
    `npm run verify` redirected to
    `pages-task3-verify-final-20261116c.log`.
    **verify: ok; 1206 tests, 1203 passed, 0 failed, 3 skipped**, plus syntax,
    security and Compose checks. Earlier first full run without the PGlite env
    had 4 skips; final runs include the disposable SQL schema gate and have 3.
12. `git diff --check`: exit 0 before commit; localized code/test diff reviewed.

## Evidence and intentional geometry differences

`pages-task3-final-20261116e/save.json` records slot rectangles, replay mutation
IDs and results. Screenshots for each width: `*-dirty.png`, `*-saved.png`,
`*-lost-ack.png`, `*-conflict.png`; phones also have `*-short-viewport.png`.
Permission screenshots: `390-author-permissions.png`, `390-publisher-permissions.png`.
Visually reviewed phone lost ACK/short viewport/conflict and desktop saved captures.

Dirty and saved Save rectangles are identical at each width:

- 320: x=12, y=60, 144 × 44.
- 390: x=12, y=60, 179 × 44.
- 768: x=232, y=64, 172 × 44.
- 1366: x=967.25, y=2.5, 172 × 44.

The header can grow for longer uncertainty/conflict text; this is intentional
instead of clipping/hiding live status. The phone source's 64 px header with
hidden status/Save in overflow and Publish in the second toolbar is deliberately
replaced by a visible action/status group in the header. Publish now has a real
44 px height, not a 36 px box with a pseudo-target. Desktop idle header72,
bar56, source paper/rail/anchored-panel checks remain active and passed in the
functional broad run. Save reserves 172 px on desktop/tablet, and phone actions
share the available row; the confirmed Salvo label does not shift their slots.
The previously approved unscaled text toolbar remains 412 px, not old source
329 px. No new reference images or false equality claims were introduced.

## Limits and handoff

Only loopback API, disposable serialized PGlite, synthetic identities and newly
created local templates are evidence. Not native PostgreSQL 16 concurrent-process
testing, Firebase sign-in, Nginx, real mobile soft-keyboard/physical touch or
production acceptance. The short viewport is a browser-resize check, not a claim
of physical keyboard testing. No new global Axe audit was run. Existing Linux
flock/symlink and unavailable external-reference checks account for the 3 verify
skips. Runtime manifest remains Node 24; changes introduce no new Node >18 API.
General inspector fields/modal redesign are not part of this task.

No blocking implementation issue remains for Task 3. Parent should retain the
strict geometry distinction and the observed intermittent broad panel result
when reviewing. No test coverage or screenshot visibility was reduced to pass.

## Commit

`fix(pages): keep save and operation states visible`

Base `309aeac`; the completion response supplies the resulting commit hash.
