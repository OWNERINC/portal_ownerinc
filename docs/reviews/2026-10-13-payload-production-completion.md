# Payload production completion: initial decision and evidence

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
