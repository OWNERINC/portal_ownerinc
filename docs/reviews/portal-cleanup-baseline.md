# Portal cleanup preservation baseline

Date: 2026-11-03

Linear issue: `OWN-36`

Repository: `OWNERINC/portal_ownerinc`

## Preserved references

| Source | Observed commit | Remote branch | Annotated tag |
|---|---|---|---|
| `origin/main` | `a6d863e74908e7888d9fc99ee9cb82bb3d7edca5` | `archive/payload-platform-2026-11-03` | `payload-platform-frozen-2026-11-03` |
| PR #82 head | `7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9` | `archive/payload-pr82-2026-11-03` | `payload-pr82-frozen-2026-11-03` |

Remote references:

- [Archived platform branch](https://github.com/OWNERINC/portal_ownerinc/tree/archive/payload-platform-2026-11-03)
- [Archived PR #82 branch](https://github.com/OWNERINC/portal_ownerinc/tree/archive/payload-pr82-2026-11-03)
- [Frozen platform tag](https://github.com/OWNERINC/portal_ownerinc/releases/tag/payload-platform-frozen-2026-11-03)
- [Frozen PR #82 tag](https://github.com/OWNERINC/portal_ownerinc/releases/tag/payload-pr82-frozen-2026-11-03)
- [PR #82](https://github.com/OWNERINC/portal_ownerinc/pull/82)

`git ls-remote` confirmed that both remote branches resolve directly to the
observed commits. The annotated tags have distinct tag objects and peel to the
same respective commits.

## Cleanup boundary

- Pre-Payload candidate: `240dee0a9553a5d7c397ae907b3fb75493eb08c7`.
- First Payload commit: `f078489bfed4f56df914796915e7163cbe85280c`.
- Both commits were confirmed to exist locally as commit objects.
- This issue does not create or validate the future pre-Payload line; that work
  remains blocked behind the ordered project chain.

## Pre-execution inspection

- The execution started from an isolated worktree and branch created from the
  fetched `origin/main` commit.
- The existing local `main` worktree was not used because it was one commit
  ahead and 44 commits behind `origin/main`.
- The previously active worktree contained unrelated untracked user artifacts.
  They were left in place and were not staged, moved, modified, or deleted.
- Other existing worktrees and their branches were not modified.
- PR #82 was observed as `OPEN`, not a draft, and not merged before preservation.

## Commands and observed results

```text
git fetch origin --prune
  completed; removed stale remote-tracking ref origin/fix/payload-b0-inventory

git rev-parse origin/main
  a6d863e74908e7888d9fc99ee9cb82bb3d7edca5

gh pr view 82 --json state,headRefName,headRefOid,url,isDraft,mergedAt,baseRefName
  state=OPEN
  baseRefName=main
  headRefName=fix/portal-final-acceptance
  headRefOid=7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9
  isDraft=false
  mergedAt=null

git ls-remote --heads origin "archive/payload-*"
  a6d863e74908e7888d9fc99ee9cb82bb3d7edca5 refs/heads/archive/payload-platform-2026-11-03
  7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9 refs/heads/archive/payload-pr82-2026-11-03

git ls-remote --tags origin "payload-*-frozen-2026-11-03*"
  payload-platform-frozen-2026-11-03 peels to a6d863e74908e7888d9fc99ee9cb82bb3d7edca5
  payload-pr82-frozen-2026-11-03 peels to 7cd7058f6862db17ef5c2fa319cf1f6c2fa1e4b9
```

## Scope and safety statement

- The current Payload platform line and PR #82 head are independently
  recoverable from remote branches and annotated tags.
- No principal reference was rewritten.
- No force-push, reset, rebase, merge, or branch deletion was performed.
- No production environment, default branch, database, upload, migration,
  deploy configuration, VPS, Docker service, or external runtime was changed.
- No editorial functionality was introduced.
- The only repository file added by `OWN-36` is this baseline document.

## Post-preservation result

- The initial baseline document was committed as
  `ae5ea3b736f4ebceb1517d5d5a2551381207c76e` and published on
  `origin/tiownerinc/own-36-freeze`.
- After remote preservation was proved, PR #82 was closed at
  `2026-11-03T13:20:20Z` with `mergedAt=null`.
- A final `git ls-remote` check confirmed both archive branches and both peeled
  annotated tags still resolve to the hashes recorded above after closure.
- The isolated worktree was clean after publishing the baseline commit.

## Verification applicability

This issue changes documentation only and performs Git preservation operations.
No application runtime or dependency changed. `git diff --check` is required for
the document change.

`npm run bootstrap` completed before the repeatable check. It installed the
locked dependencies without changing tracked manifests. The install reported 13
moderate audit findings in the API package, no findings in cron, and eight low
findings in CMS. No automatic audit fix was attempted because dependency changes
are outside `OWN-36`.

`npm run verify` completed with the following pre-existing baseline result:

```text
tests:     2123
passed:    2072
failed:    19
skipped:   32
cancelled: 0
```

The failures were confined to the following existing test files:

- `tests/unit/cms-infrastructure-preparation.test.mjs` — one host/process double
  did not exit before its test timeout;
- `tests/unit/payload-functional-guard.test.mjs` — one existing Compose guard
  assertion rejected the generated fixture text;
- `tests/unit/payload-operations.test.mjs` — three Git Bash child processes
  exceeded their 15-second test timeout;
- `tests/unit/payload-preview-https.test.mjs` — four fixture setup attempts were
  denied with `EPERM` under `C:\Users`;
- `tests/unit/payload-preview-preparation.test.mjs` — ten fixture setup attempts
  were denied with `EPERM` under `C:\Users`.

These failures were observed on the unmodified `origin/main` application state;
they were not hidden or changed as part of this documentation-only issue.
`git diff --check` passed for the baseline document.
