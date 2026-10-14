# Payload production completion: initial decision and evidence

## B0 artifact integrity — bounded read-only verification

The signed-binding-selected legacy two-store B0 verifier streams complete artifacts, validates their exact manifest/proof bindings, and compares the actual uploads tree with the signed fingerprint. Retained descriptors and final evidence/journal checks protect observation consistency. Success means `integrity_verified`, not database restoreability, live-source verification or rollback authorization; installation/deployment remain unauthorized.

Independent review found cumulative PAX metadata and extension-recursion risks. The opt-in bounded parser now limits aggregate extension work and global metadata and discards processed member objects; historical parsing is unchanged. Real compressed-byte regressions showed red-before-fix and bounded rejection after correction. Three new fixed error identifiers were added to the existing context-gated allowlist following full-suite failures.

A subsequent local failure in ancestor identity was investigated with one controlled sibling-temp creation. It reproduced shared-ancestor mtime drift; the exact component in the original failed run was not captured. Only the fixture now consistently models protected ancestors above its sandbox, retaining live sandbox/artifact observations and inode checks. Fresh independent reviews approved the parser, allowlist and fixture corrections. Logs of failures remain preserved.

Primary focused checks passed **27 / zero failures**. Complete `npm run verify` then passed **Portal 1,851 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-production-b0-isolated-fixture-verify.log`). Tests explicitly double host metadata; native qualification and actual isolated restoration remain pending. No VPS operations occurred.

## Production binding v3 and independently versioned receipts

Added explicit production binding v3 under the unchanged outer state schema v2, with signed source-approval/policy/record context, strict correspondence validation and versioned creation receipts. Reservations retain exact metadata; receipts are append-only at the permitted stage and require four containers plus two CMS volumes before the bound boundary. Historical unversioned/v2 bodies and the old persistent fingerprint algorithm remain unchanged. The new production algorithm sorts only validated outer mount records and includes its own version tag.

The read-only plan recognizes v3 while retaining explicit execution blockers and false authorization flags. No production creation action or initializer dispatch was added. Independent code review returned `ship`. Primary full `npm run verify` passed **Portal 1,844 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-production-binding-v3-verify.log`). Native production qualification, verified B0 recovery and fenced rollback remain pending. No host operations occurred.

## P3 authenticated read-only production installation plan

The fixed receipt-selected plan check authenticates archive bytes, exact extracted tree, policy/record bindings, approved host observations and signed state under the existing lease. State reading disables head repair and does not construct the mutating runtime. Classification always leaves installation and deployment authorization false. B0 presence is explicitly unverified for artifact integrity and restoreability.

Independent review found retained-install blockers were omitted when restore and install intents coexist. The corrected classifier preserves restore priority while evaluating both sets of blockers; a legally transitioned, HMAC-signed coexistence regression covers missing B0, receipt gaps and candidate mismatch. Fresh review returned `ship`.

The initial full verification failed once in the unrelated Academy progress suite with only a generic file-level failure; the log was retained. Sequential Academy plus production-plan checks passed **20 / zero failures**, without test or timeout changes. Subsequent complete `npm run verify` passed **Portal 1,840 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-production-install-plan-final-verify.log`). The earlier failure's cause is unconfirmed. No native host qualification or VPS changes are claimed.

## POSIX preparation fixture correction

Candidate `38488642070` at `d33b4c4` failed verification before native qualification/recovery. Two host-baseline fixtures combined synthetic root-owned files with the real non-root runner identity. The actual state reader correctly refused that mismatch. A fixture-only correction now scopes and restores a consistent POSIX/root caller model; production code is unchanged. Regressions retain real signed-state verification and require exact refusal for unsafe metadata and altered HMAC. Independent review returned `ship`.

Primary complete `npm run verify` passed **Portal 1,836 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-preparation-posix-fixture-verify.log`). Native Linux rerun remains pending. Earlier recovery PASS `38480525768` continues to qualify only `e8e86b6` and its exact images.

## Mandatory native preparation-lease qualification wiring

The existing candidate native gate now runs the complete preparation-authentication suite with `PAYLOAD_REQUIRE_NATIVE_PREPARATION=1`. Unsupported Linux/root execution fails rather than skips. The private native fixture checks actual flock/subprocess inheritance, shared-lock refusal without mutation, retained parent exclusivity, contention, replaced paths and cleanup. It does not qualify full preparation end to end.

Review corrected the retained-parent proof to use a separate shared-lock probe (an exclusive probe could not distinguish a downgraded shared lock), and a subsequent embedded-Python indentation mistake was fixed. Fresh code review returned `ship`; primary extraction and `ast.parse` of the complete native Python passed.

Full `npm run verify` passed **Portal 1,834 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-native-preparation-lease-verify.log`). The final test-only corrections occurred during that run, so primary reran the affected preparation/workflow suites afterward: **17 PASS / 1 native skip / zero failures**. Native Linux execution remains pending and is not implied by either result. No VPS operations occurred.

## Authenticated inactive preparation dispatch

The launcher now dispatches authenticated check/apply while retaining the same deployment lease and passing FD9. The preparer revalidates its fixed context and derives approved baseline/predecessor values and the CMS image from authenticated inputs; direct legacy invocation retains its old pins. Apply remains inactive preparation only, without service activation or deployment authorization.

Independent review found that the inherited-lease check could upgrade a shared lock. The corrected independent probe uses shared nonblocking acquisition to reject shared/unlocked descriptors before touching FD9, retaining the same-open-description check for the exclusive case. The regression verifies that rejected shared FD9 remains open and unchanged. Fresh code review returned `ship`; native Linux handoff/lock execution remains pending.

Primary complete verification was rerun after that correction: **Portal 1,834 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Evidence: `%LOCALAPPDATA%/Temp/opencode/payload-preparation-dispatch-final-verify.log`. Portable host/protocol tests do not qualify end-to-end native preparation or the actual VPS. Interrupted preparation can leave partial state requiring investigation; no rollback guarantee is claimed. No live host operations occurred.

## Read-only preparation host eligibility under lease

The fixed verification launcher now acquires the existing deployment lock without creation/truncation and verifies approved host bytes and hardcoded initial-state eligibility under that lease. It refuses occupied FD9, busy/replaced locks, mismatched baselines, partial control state, noninitial signed state and closed admission. Authenticated state code uses captured inventory bytes. The lease is released before returning; this report is not reusable execution authorization. Preparation dispatch and pin replacement remain disabled.

Independent code review returned `ship`. Primary full `npm run verify` passed **Portal 1,830 PASS / 16 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Evidence: `%LOCALAPPDATA%/Temp/opencode/payload-preparation-baseline-verify.log`. Native flock and end-to-end host preparation remain separate pending gates. No VPS operations occurred.

## Preparation authority — install and verify only

The preparation provisioning profile binds the exact 15-file closure and publishes the independent approval last. The fixed launcher authenticates captured source and the admission toolchain before executing their validators. It uses the existing record/policy validators and accepts only `--check`; host-baseline checking, archive-byte verification, preparation execution and deployment authorization remain explicitly false. Existing preparer pins remain unchanged.

Independent code review returned `ship`. Primary `npm run verify` passed **Portal 1,826 PASS / 15 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Evidence: `%LOCALAPPDATA%/Temp/opencode/payload-preparation-authority-verify.log`. Portable preparation fixtures use explicit metadata/publication doubles; the native candidate trust fixture does not establish end-to-end native preparation-launcher acceptance. No VPS installation or host eligibility is claimed.

## Quiescence failure attribution and progress upload correction

The initializer now preserves a bounded summary from the exact inventory that rejected quiescence: allowlisted service/state buckets, capped counts and overflow indication. Its operational predicate, closed admission, pre-B0 refusal and exit remain unchanged. Parsing requires the exact initializer failure context; the summary is included only in the failed report, not the 1 KiB progress checkpoint. This does not establish which service caused the earlier run.

The redacted checkpoint now explicitly applies `0644` to its exclusively owned temporary descriptor before fsync/rename, preventing restrictive recovery umask from denying the artifact uploader access. No global umask or private-evidence permissions change. The corrected POSIX regression emits and checks successive checkpoint records; native execution remains pending.

Both bounded changes received independent code-review `ship`. Primary focused checks passed **37 / 1 POSIX skip / zero failures**. Complete `npm run verify` passed **Portal 1,820 PASS / 15 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Log: `%LOCALAPPDATA%/Temp/opencode/payload-quiescence-final-verify.log`. No VPS changes or recovery acceptance are claimed.

## Mandatory native trust fixture wiring

The candidate-only native gate now also runs the trust-provisioner suite with `PAYLOAD_REQUIRE_NATIVE_TRUST=1`, so unavailable native execution fails rather than skips. The unique `/root` sandbox redirects only destination constants; production destinations remain unchanged. The fixture asserts actual filesystem metadata, nofollow reads, no-replace rename, interrupted installation/retry, policy-last publication and existing-record preservation. This is not a power-loss test or SSH authorization proof.

Independent code review returned `ship`. Primary complete local verification passed **Portal 1,818 PASS / 14 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`** (`%LOCALAPPDATA%/Temp/opencode/payload-native-trust-wiring-verify.log`). Native execution itself is still pending.

Candidate `38473939196` at earlier commit `7fec457` failed before restores: final report artifact `11856680769` records `payload_initialize_isolated`, phase `quiescence`, stage `none`, `writers_not_quiescent`. Source and target initial comparisons passed, but lease fixture initialization failed. No negative scenarios or restores were reached. Independently, progress upload failed with `EACCES`; the final report upload succeeded. Inspection localizes the primary rejection to disallowed running containers in the same-project inventory after successful Compose stop; the specific service and underlying cause are not yet known. Diagnostic follow-up is pending; this run does not qualify the writer identity correction.

## P2 offline trust provisioner — reviewed local result

Implemented the root-administrative offline provisioner with independently approved input hashes, absent-or-identical fixed-path installation, retained snapshots and policy-last publication. Independent review found a retry durability gap after successful directory creation followed by failed parent fsync. Apply now reaffirms every validated non-root segment's parent, including existing segments; check remains read-only. A red-before-fix regression covers that interruption. Fresh code review returned `ship`.

The initial full verification failed in three local subprocess tests (one explicit `ETIMEDOUT`, two null exit statuses near their limits). It was not accepted. Sequential diagnosis of infrastructure/operations passed **42 / 2 platform skips**, and the corrected provisioner suite passed **6 / 1 native skip**, without increasing timeouts. A subsequent complete `npm run verify`, without competing local suites, passed: **Portal 1,818 PASS / 14 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Log: `%LOCALAPPDATA%/Temp/opencode/payload-trust-final-verify.log`. The earlier failure log remains preserved; resource contention is suggested, not proven.

Native Linux ownership, FD/fsync and no-replace publication acceptance remains pending. The provisioner does not authenticate itself, rotate differing policies, register candidates, authorize preparation-source execution or change the preparer's existing pins. Nothing was installed on the VPS.

## P2 restricted admission transport — local verification

Candidate CI `38471750552` stopped in verification before recovery: the progress-artifact test still asserted the former 60-minute recovery budget. That assertion now matches the approved 120-minute step; artifact and acceptance contracts remain unchanged.

The complete P2 checkout passed primary `npm run verify`: **Portal 1,812 PASS / 13 skips; CMS 448 PASS / 11 skips; zero failures; `verify: ok`**. Evidence: `%LOCALAPPDATA%/Temp/opencode/payload-p2-complete-verify.log`, external fixture parent `C:\Users\Public`. Review requested two corrections (obsolete receipt path in the runbook and an inaccurate preparation completion message); both were applied and independently rechecked with code-review verdict `ship`. Post-correction focused checks passed **64 tests / 2 platform skips / zero failures**. `git diff --check` passed.

The restricted launcher, fixed sudo transport, protected incoming directory and ordered installer dependency publication are implemented and tested locally with explicit host/transport doubles. Native Linux sudo/SSH validation, protected verifier/policy/records provisioning and recovery qualification remain pending. The existing source approval pin is unchanged; successful admission still ends in `release_not_preflighted`. Nothing was installed on the VPS by this block.

## P1 local verification — writer ticket v2 and candidate budget

Primary full `npm run verify` completed with `verify: ok`: Portal **1,803 PASS / 13 skips / zero failures**, CMS **448 PASS / 11 skips / zero failures**. Log: `%LOCALAPPDATA%/Temp/opencode/payload-writer-v2-verify.log`; external fixture parent was `C:\Users\Public`.

The candidate budget patch was completed while that run was active. Its new regression and affected workflow/registry/stop-budget tests were therefore checked separately by primary: **20 PASS, zero failures/skips**. Primary writer/diagnostic focused checks: **14 PASS, zero failures/skips**. Both bounded patches received independent code-review `ship`; native Linux recovery remains pending. Final `git diff --check` and `npm run security` passed; audit reported zero vulnerabilities in the configured production scopes.

Mount normalization corrects the reproduced order instability, without asserting it caused the historical run. Temporary coordinator tickets use v2 only. Persistent creation receipts retain their existing algorithm pending explicit versioned treatment. No VPS service change has been made.

## Bounded P1 outer recovery budget

Timing evidence supplied by primary from CI `38454684188`: validation before
recovery took 9.32 minutes; recovery ran 55.98 minutes; first restore began at
50.3 minutes and failed after 5.62 minutes. Source backup took 5.61 minutes,
three initializations 5.93–6.02 minutes each, and three stops 4.0 minutes each.
These are observed timings of a failed run, not a forecast of successful recovery
and not evidence of which identity component failed. No new CI was run for this
budget patch.

The sizing basis is the measured 50.3-minute prefix plus **three remaining
coordinator calls** (first restore, second source backup after live edit, second
restore), each retaining its existing 15-minute cap: **95.3 minutes** before
remaining snapshots, comparisons, readiness and cleanup. The recovery step cap
is therefore 120 minutes, leaving 24.7 minutes of estimated reserve. This is an
explicit bounded allocation, not a wall-clock guarantee or expected runtime.

The validate job cap is 150 minutes only for branch `workflow_dispatch` with
`publish_candidate_only == true` and `cms_image_only != true`, matching the
recovery step's existing mode gate. Its 30-minute non-recovery allocation exceeds
the observed 9.32-minute prefix by 20.68 minutes for other work, qualification
and artifact uploads. Ordinary validation, CMS-only dispatch, push and PR jobs
retain 90 minutes; the production deploy job retains 25 minutes.

Only those two outer timeout fields change. No subprocess/HTTP/stop/curl budget,
14-check/11-negative acceptance contract, two-restore requirement, qualification,
manual flag, permission, artifact path or deployment gate changes. Skipping
acceptance work would invalidate recovery; moving it to a dedicated job would
require unrelated artifact/permission/cache transport changes. Neither is part
of this bounded patch. More time does not fix writer identity, prove recovery,
or establish production completion. Cancellation can still prevent cleanup or
artifact upload; fresh review and separately authorized CI remain necessary.

## Decision

User approved the installation/activation design and implementation, restricted to Portal services. Notify before any n8n alteration. Work proceeds in the isolated `payload-production-completion` worktree from `be6db91`; unrelated untracked files were carried with the session and remain preserved.

The first patch authenticates candidate bytes before receiver extraction, retaining the production installation denial. The subsequent dependencies are production initialization and B1/closed recovery, operational support for populated/protocol-present authority phases, import/reconciliation/coverage/seal/activation, and real native editorial acceptance.

## Proven facts

- GitHub PR #60 was merged into `main` as `ce324b1b3d36fafb98270c9dfd8e62fed87d67a3` from `125ab1e`. After fetching `origin/main`, `git diff --stat origin/main HEAD` reports only the two-file four-service stop-budget correction (12 insertions, 3 deletions).
- Read-only VPS observation: `current-release` points at the `ce324b1` release. The pointer is `deploy:deploy`, mode `0644`; its `.image-env` is `deploy:deploy`, mode `0600`. Numeric deploy UID/GID are both 1000.
- Production runtime configuration was observed as `deploy:deploy/0600`. This is not independent candidate-policy authorization.
- Production policy `/etc/ownerinc/payload-candidate/production-policy.json` was absent at inspection.
- The runtime `payload-*` inspection returned only `payload-operations-guard`, root-owned mode `0755`; no runtime controller inventory/state appeared in this bounded depth-two inspection.
- Compose-label-filtered volumes for `ownerinc-portal-prod` returned only `ownerinc-portal-prod_postgres_data` and `ownerinc-portal-prod_uploads_data`. This is not proof that no differently labelled residual CMS resource exists.
- Filesystem hosting the Portal application reported 113 GiB available. No storage changes were made.
- Source receiver extracts at `ops/deploy-from-ci.sh:316–318` before its three-image branch and unconditional installation preflight at `:358–364`.
- Existing candidate verifier checks protected policy, installed toolchain, record, exact bytes and request tuple, requires root POSIX with isolated Python, and does not extract candidate content.

## Unconfirmed hypotheses

The public 502 is consistent with the observed proxy destination and absent CMS container. End-to-end availability and editorial mutations must be checked again after an admitted installation; readiness alone is insufficient. The initial bounded resource checks do not establish a complete production installation inventory.

## Resolved divergences

Two independent investigators and one bounded cross-critique agree: receiver admission is the first operational patch. Import-first development would not address the production installation dependency. Neither preauthority recovery qualification nor protocol finalization authorizes native publishing. The concern about unrelated newer Portal code was resolved by the actual Git comparison.

## Residual risks

Exact bytes must remain protected between verification and extraction. Installed verifier/policy are independent trust anchors. Production initialization must not impersonate the disposable initializer. B0 does not replace B1; normal preauthority recovery does not yet support frozen or Payload-authoritative populated stores. Existing installation and authority denials remain until their respective integration is verified.

## Verification plan and authorization

Implementation is explicitly authorized. The first patch requires real parsing/ordering regressions, installed-verifier binding checks, legacy compatibility, denial before extraction/effects, accepted admission still reaching installation denial, focused checks, fresh independent review and full local verification. Native Linux evidence remains separate from Windows tests. The candidate CI `38436732170` was still in progress at the last observation; this document makes no PASS claim for it.

No production services, databases, ownership, policies or other VPS projects were changed by these inspections. No n8n operation was performed.

## Admission implementation and preparer correction

The bounded receiver patch adds a fixed installed transport helper, explicit Payload selectors, protected bounded receipt, installed-verifier admission and extraction from the verified immutable bytes. Valid admission still terminates closed; it does not install the CMS.

Fresh review initially returned `fix-first`: the preparer could publish the revised receiver without its new helper, breaking legacy deployment. The follow-up installs and checks the root-owned helper before receiver publication, includes it in dry-run/idempotence/snapshot checks and preserves the old receiver on dependency failure. A fresh reviewer returned `ship` for that correction, without claiming native installation acceptance.

Primary checks:

- Receiver/candidate/operations focused tests: 75 PASS, zero failures, one native Linux/root skip.
- Final preparer/receiver focused tests: 31 PASS, zero failures, three platform skips (two symlink cases and one native Linux/root case).
- `git diff --check`: PASS.
- `npm run security`: PASS, zero vulnerabilities in the configured production dependency scopes. Bootstrap's broader API dependency audit separately reported seven moderate vulnerabilities; these scopes are not interchangeable.

The first full verification in the new worktree ended with 1,768 PASS, 12 failures and 13 skips. All twelve failures were `EPERM` creating preview fixtures below `C:\Users`: the tests selected the parent of the highest Git ancestor, and `C:\Users\Criação` itself contains `.git`. The original log is preserved at `%LOCALAPPDATA%/Temp/opencode/payload-receiver-primary-verify.log`.

The test-only follow-up adds optional `PAYLOAD_TEST_EXTERNAL_PARENT`, validated by the existing real external-root guard and writability check. Unset behavior is preserved. `C:\PROJETOS` was rejected because it also contains `.git`; `C:\Users\Public` was used successfully by the focused run (implementer evidence: 27 PASS, no failures/skips). No repository marker, ACL, production boundary or HTTP behavior was changed. A separate fresh review returned `ship` for this test-only change.

## Final local verification

Primary full `npm run verify`, with `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Users\Public`, completed successfully and emitted `verify: ok`:

- Portal: **1,803 tests; 1,790 PASS, zero failures, 13 skips**, 258.512 seconds.
- CMS: **459 tests; 448 PASS, zero failures, 11 skips**, 35.122 seconds.
- Final security audit: zero vulnerabilities reported in each configured production package scope.
- Final `git diff --check`: PASS.

Log: `%LOCALAPPDATA%/Temp/opencode/payload-receiver-final-verify.log`. The earlier failed full verification remains preserved separately; this result does not erase it.

Primary inspected the receiver routing/extraction diff, helper implementation, installer dependency publication ordering, test-only path override and matching regression changes. Reviewed code remains admission-only. Native Linux/root installation and the complete production CMS activation/editorial journey remain pending. No deployment or VPS service change was performed in this block.

## Recovery timeout diagnostic block

CI `38436732170` subsequently completed with a 60-minute recovery-step timeout. GitHub exposed only candidate, CMS digest and SBOM artifacts; the recovery report was unavailable. Two read-only analyses and one bounded cross-critique established the absence of live boundaries and terminal-only reporting, not the cause of the timeout. No timeout or retry increase was made.

The diagnostic patch emits finite allowlisted stage/command boundaries and an atomic latest checkpoint capped at 1 KiB. It has a separate nonqualifying artifact; the acceptance report and qualifier inputs are unchanged. Every subsequent record retains the first normalized failure, including during holds. Private command data is never serialized. Fresh independent review returned `ship`, including the final first-failure correction.

Primary final checks: progress/diagnostics/readiness **28 PASS, zero failures/skips**; full `npm run verify` **PASS**, Portal **1,802 PASS / 13 skips / zero failures**, CMS **448 PASS / 11 skips / zero failures**, final `verify: ok`; `git diff --check` PASS. Full verification used the same validated `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Users\Public` override. Log: `%LOCALAPPDATA%/Temp/opencode/payload-progress-final-verify.log`.

These results validate the diagnostics locally; they do not identify the historical timed-out operation or qualify recovery. One new candidate execution is the next evidence-gathering step. Production remains unchanged.
