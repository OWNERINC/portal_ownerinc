# Login aurora — isolated local integration, 2026-11-09

## Outcome and boundary

**PASS for the committed aurora composition in this integration worktree.**
The source branch was fast-forwarded without conflicts. No runtime or test fixes
were needed. This integration adds only this evidence document after the merge.
**Merge into local main remains PENDING the user's resolution of its dirty work.**
This is not approval of the source worktree's uncommitted login redesign.

Worktree:
`C:/Users/Criação/.local/share/opencode/worktree/1d3818751ec06812d576140b7db36d298a97e7bd/login-aurora-integration`

Branch: `integration/login-aurora-local`.

No push, PR, deploy, Docker invocation, real authentication, email delivery,
production access, subagents, worktree removal, or changes to other worktrees.
The existing approved design was used without reopening design decisions.

## Recorded identities and pre-integration state

Before merging, `git status --porcelain=v1 --branch`, `git show-ref --heads`,
`git worktree list --porcelain`, history and source commit statistics were read.
The integration worktree was clean.

- Integration starting HEAD: `878109eeaaec2e32ec91efe098e7c577f32356bb`.
- `origin/main` already pointed at that same starting commit; no fetch was run.
- Local `main`: `952a038d528f72dbf20f11cb8e7ac7fcbff7639b`.
- Source branch: `feat/login-approved-v35`.
- Source/spec commit: `0ebb59d769e164070e266521c4453f6a7aa30b0b`.
- Source/implementation and post-fast-forward HEAD:
  `b737c04b9e5575e794198cd3fd99a3a3bfc7f8d2`.
- `git rev-list --left-right --count integration/login-aurora-local...feat/login-approved-v35`
  returned `0 2` before integration.

The existing integration base was four commits ahead of local main, not equal
to it. This inherited difference was recorded, not repaired by moving main:
`98d3939`, `e6e9aad`, `ed1f3f8`, `878109e`. The only two commits integrated by
this task were `0ebb59d` and `b737c04`.

Read-only main status before merging showed:

```text
## main...origin/main [behind 4]
 M public/css/dashboard-home.css
?? .opencode/
?? docs/operations/agent-reviews/
?? docs/operations/native-team-pilot.md
?? scripts/portal-team-mcp.mjs
?? tests/unit/portal-team-mcp.test.mjs
```

No checkout, ref update, staging, stash, reset, or clean operation was performed
in `C:/PROJETOS/_ownerinc_portal`. Read-only status/hash commands used
`git --no-optional-locks -C C:/PROJETOS/_ownerinc_portal`.
After the fast-forward, main's ref, status, and SHA-256 hashes of all 11
modified/untracked files were captured in `main-preservation-before.json`.
After validation they were recaptured in `main-preservation-after.json`;
the complete snapshots matched exactly. The status also matched the status
recorded before merging. Other worktree paths and refs were only enumerated;
no externally managed worktree was modified or removed.

## Integration and committed scope

Executed noninteractively:

```powershell
git merge --ff-only --no-edit feat/login-approved-v35
git status --porcelain=v1 --branch
git rev-parse HEAD main feat/login-approved-v35
git diff --check
```

Result: fast-forward `878109e..b737c04`, no conflicts, clean integration tree,
HEAD identical to the requested source SHA, main unchanged.

The two source commits introduce six paths: the approved spec, plan, source
review, aurora unit/browser tests, and a 26-line append to
`public/css/login.css`. Diff inspection confirmed the existing 55-line CSS
prefix remained unchanged. `public/login.html`, `public/js/login.js`, auth,
assets, tokens, existing tests and lockfiles were not changed by this task.
`git diff b737c04 HEAD -- public tests` was empty before the evidence commit.
No dirty or untracked source files were copied, read as implementation inputs,
or staged.

## Actual commands and results

Node: `v24.15.0`; npm: `11.12.1`. These match the committed verifier's Node 24
requirement. No package or engine changes were made.

1. `npm.cmd run bootstrap`: PASS. Existing lockfiles installed 324 API packages
   and 17 cron packages into this worktree. API install reported 13 dependency
   vulnerabilities (10 moderate, 3 high) and existing deprecation warnings;
   cron reported zero vulnerabilities. No audit fix or dependency changes were
   attempted. This is an outstanding dependency warning, not an aurora change.
2. Confirmed port 4187 had no listener using `Get-NetTCPConnection` before
   starting the fixture server. Set `$env:PORT = '4187'` and executed
   `node tests/visual/serve-conecta.mjs` in the background. Its listener was
   exclusively `127.0.0.1:4187`, owned by this task's Node process PID 30576.
3. Executed the focused browser check with external Playwright:

   ```powershell
   $env:PLAYWRIGHT_MODULE_PATH = 'C:/Users/Criação/AppData/Local/Temp/opencode/conecta-browser-tools/node_modules/playwright/index.mjs'
   $env:VISUAL_ORIGIN = 'http://127.0.0.1:4187'
   $env:VISUAL_OUTPUT = 'C:/Users/Criação/AppData/Local/Temp/opencode/login-aurora-integration/browser'
   node tests/visual/check-login-aurora.mjs
   ```

   **PASS, 6 cases**: widths 360/402/1366 × reduced/normal motion. Recovery and
   registration opened and returned successfully; no horizontal overflow,
   blocked vertical scrolling, or page JavaScript errors were observed. Both
   decorative layers had gradients, `pointer-events: none`, z-index -1,
   opacity 1 and identity transforms at completion. Normal motion had exactly
   two finished 900 ms, single-iteration animations; reduced motion had none.
4. Executed full verification on the clean committed composition:

   ```powershell
   $env:PATH = 'C:\Program Files\Git\bin;' + (($env:PATH -split ';' | Where-Object { $_ -notmatch '(?i)docker' }) -join ';')
   npm.cmd run verify
   git diff --check
   ```

   **PASS: 827 tests total, 825 passed, 0 failed, 2 skipped; `verify: ok`.**
   Git Bash was selected ahead of WSL. Docker paths were excluded only from
   this verification process's PATH to honor the no-Docker instruction;
   Compose validation explicitly reported unavailable/skipped. Syntax, shell
   syntax, tests, secret scan and DHO naming checks completed. Existing
   `MODULE_TYPELESS_PACKAGE_JSON` warnings were not changed. The two explicit
   skips cover Linux real-flock concurrency and Linux symlink escape semantics
   that Git Bash on Windows does not establish. `git diff --check`: PASS,
   no output.
5. Repeated `npm.cmd run verify` after adding this evidence document, with the
   same process-local PATH: **827 total, 825 passed, 0 failed, 2 skipped;
   `verify: ok`**. Output: `verify-with-evidence.log`. `git diff --check` also
   passed; the only own uncommitted path was this document.
6. Confirmed listener PID 30576, its Node command line and parent PID 38736
   still matched the fixture server started here, then stopped only PID 30576
   using `Stop-Process`. The background shell's exit code 1 reflects explicit
   process termination after the successful browser run, not a browser failure.

## Independent screenshots and inspection

Evidence root (external, not committed):
`C:/Users/Criação/AppData/Local/Temp/opencode/login-aurora-integration/`.

Actual outputs:

- `verify-committed.log`: full verify output for the clean `b737c04` tree.
- `verify-with-evidence.log`: repeated full verify with this document present.
- `browser-check.log`: focused browser PASS output.
- `browser/results.json`: all six computed-style/motion/navigation results.
- `browser/login-360-reduce.png`.
- `browser/login-402-reduce.png`.
- `browser/login-1366-reduce.png`.
- `browser/login-360-no-preference.png`.
- `browser/login-402-no-preference.png`.
- `browser/login-1366-no-preference.png`.
- `main-preservation-before.json` and `main-preservation-after.json`.

The four 360/1366 px screenshots in both motion modes were opened and inspected.
They show this committed composition: the original Conecta wordmark and PodFalar
button on the brand side, the existing form arrangement, plus the low-opacity
purple upper/left and orange lower/right aurora behind the opaque form panel.
Controls and text remain readable. The mobile page is taller than its viewport
and scrolls naturally; the fixture banner is injected by the preview server and
can overlay content in the full-page capture. It is not production login UI.
These are new captures, not the source worktree's approved-layout screenshots.

## Differences, limitations and pending work

- The source working-tree report records 838 tests total / 836 passed / 2 skips.
  This clean committed tree has 827 total / 825 passed / 2 skips: 11 fewer tests.
  Source-only pending tests/assets/layout were intentionally excluded, not
  copied in to reproduce the larger count.
- Contrary to the anticipated possible label mismatch, committed
  `public/login.html` already has the exact button label `Esqueci minha senha`.
  The unmodified aurora browser check passed; no selector fallback was needed.
- No significant incompatibility blocks the isolated aurora integration.
  This does not integrate or approve the source's pending layout, JS, assets,
  or source-only regression tests.
- `check-login-approved.mjs`, `login-approved-reference.test.mjs` and
  `podfalar-brand-assets.test.mjs` are not part of this committed composition
  and were not run. The source's 40 axe audits are not results for this tree.
  No new axe audit was run here; external axe availability is not test evidence.
- Only the focused Chrome fixture check was executed. No Safari/Firefox,
  physical-device/virtual-keyboard or unsupported-`color-mix` test was run.
  It does not prove real Firebase, API/bank persistence, password reset email,
  registration delivery, first-password submission, or external PodFalar access.
- Docker/Compose, full-stack services and production were not exercised.
- **Main merge remains PENDING** until the user resolves the dirty main checkout
  and separately authorizes final integration. No push, PR or deploy is included.
