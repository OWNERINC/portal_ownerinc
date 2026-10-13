# Payload production completion: initial decision and evidence

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
