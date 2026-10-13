# Payload receiver admission implementation plan

> Execute with the sole `sol-advisor-implementer` worker, then a fresh read-only review and primary verification.

**Goal:** authenticate incoming Payload candidate bytes before release-tree extraction while retaining the production installation denial.

**Architecture:** the receiver uses the existing operator-installed candidate verifier and protected policy/record. An explicit Payload request supplies selectors, never authorization. Legacy two-image requests retain compatibility but cannot carry a three-image candidate around admission. Installation, B1 recovery, operational phase extension, import and activation follow as separately verified dependent blocks.

**Tech stack:** Bash receiver, isolated Python verifier, dependency-free Node regression tests; Linux production.

## Global constraints

- User approved this design and implementation on 2026-10-13; Portal only. Notify before any n8n change.
- Preserve existing content, IDs, media, versions, databases, signed state and failed evidence.
- No changes to another VPS project, no speculative retry loops, no weakening of authority or recovery checks.
- Use fixed installed verifier `/opt/ownerinc/lib/payload-candidate/ops/payload-candidate-verifier.py`, existing protected policy and registry. Candidate code cannot verify itself.
- Keep `install_receiver_preflight()` unconditionally closed in this block.
- Preserve unrelated untracked files carried into this worktree.

## Task 1: Receiver admission boundary

**Owned files:** `ops/deploy-from-ci.sh`; one small receiver helper under `ops/` only if required to safely bind byte consumption; `tests/unit/payload-receiver-admission.test.mjs`; matching existing receiver assertions; `docs/operations/deployment.md`.

**Consumed interface:** installed verifier `verify --archive PATH --commit SHA --run-id ID --run-attempt N --api-image DIGEST --cron-image DIGEST --cms-image DIGEST --candidate-artifact-id ID --qualified-artifact-id ID --report-artifact-id ID`, invoked with isolated Python (`-I -S`) and a clean environment. Its output is admission evidence, never installation permission.

**Produced interface:** explicit versioned Payload request carrying precisely those selectors; exact syntax documented and tested. Existing `production:SHA` and `staging:SHA` remain legacy inputs. Reject extra/duplicate fields, malformed identifiers, staging Payload requests and caller-selected tool/policy paths.

- [ ] Write executable regression tests for missing policy/record, wrong selectors, stale policy, altered archive and Payload-via-legacy before extraction. Assert extraction/runtime traces are empty on denial. Use actual verifier binding tests for cryptographic checks and label any transport doubles explicitly.
- [ ] Run the focused test and retain the demonstrated red result.
- [ ] Implement bounded exclusive archive receipt (10 MiB maximum), protected ownership, installed-verifier invocation and same-byte verification/consumption. Never source or execute archive content. Reject links/path escapes and ambiguous manifests. Account explicitly for replacement between verification and extraction; a detached hash check alone is insufficient if another identity can replace the file afterward.
- [ ] Validate extracted commit and all three image digests against the admitted request. Preserve candidate evidence on denial; never delete existing releases or signed records.
- [ ] Keep valid admission ending at the unchanged installation denial, before Docker pulls, service actions, databases or pointer publication. Preserve legacy two-image semantics.
- [ ] Run focused tests, verifier admission tests, Bash syntax and `git diff --check`. Document precise request, prerequisite installation/ownership, diagnostics and retention behavior.
- [ ] Primary inspects actual diff; fresh reviewer returns ship/fix-first/rethink. Correct only demonstrated defects through the same implementation worker.
- [ ] Run `npm run verify` and `npm run security`; commit reviewed files only. Linux-only checks must remain explicitly pending until executed natively.

## Downstream acceptance boundaries

After this block, complete production initializer/B0/receipts and B1/closed recovery before exposing the CMS. Extend recovery for protocol-present/frozen/active phases before importing or switching authority. Then compose the existing importer, coverage, live drain, seal and durable activation. Final acceptance is real HTTPS login, native creation, original upload, draft, Versions, publication and independent Portal reading. Readiness or an admin shell does not complete that objective.
