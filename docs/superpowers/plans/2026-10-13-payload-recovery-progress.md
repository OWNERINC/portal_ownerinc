# Recovery diagnostic progress implementation plan

**Goal:** locate the operation consuming the candidate recovery budget without changing its execution, timeouts or acceptance criteria.

**Evidence:** CI `38436732170` reached the 60-minute recovery step timeout. GitHub lists only candidate, CMS digest and SBOM artifacts; no recovery report is available. The workflow, runner, command helper and smoke source are unchanged between that commit and the current receiver patch. The terminal-only report and captured subprocess output explain the lack of visible progress but do not establish a hang or its cause.

**Decision:** add synchronous finite boundary records and a separate nonqualifying checkpoint. No asynchronous process-runner rewrite, timeout increase, HTTP change or automatic retry.

## Owned files

- `scripts/test-payload-preauthority-recovery.mjs`: stage/command and terminal-path boundaries.
- New `scripts/integration/payload-preauthority-progress.mjs`: allowlisted bounded serialization and synchronous checkpoint writer.
- `.github/workflows/ci.yml`: explicit progress destination and separate redacted artifact upload. Preserve final report artifact contents and qualification input unchanged.
- New `tests/unit/payload-preauthority-progress.test.mjs` and matching existing recovery/workflow tests.
- `docs/operations/payload-runtime-recovery.md`: diagnostic semantics and evidence limitations.

## Contract

Output carries `schemaVersion: 1`, `artifactKind: diagnostic-progress`, `qualifiesAcceptance: false`. Only finite allowlisted stage, substep, event, fixture role (`source`, `target`, `leaseTarget`, `global`) and command category appear alongside sequence/monotonic elapsed/configured timeout integers. Unknown inputs map to `unknown`; never print arguments, project names, paths, environment, SQL, URLs, raw error text or subprocess output.

Emit before/after existing synchronous command calls and stage/substep transitions. Capture original failure metadata before holds, preserving any earlier primary snapshot failure. Include explicit boundaries for holds, cleanup, private evidence persistence and terminal report writing. Checkpoint is separate from the final qualification report and must not satisfy its schema. A missing end record means completion was not observed, not proof of a hang.

Checkpoint write failure cannot replace an operational failure or prevent failure holds. Use a bounded latest-state checkpoint rather than accumulating unbounded history. Public console events are finite and emitted only at existing boundaries; no heartbeat/retry loop. Keep the final report artifact separate so existing package/qualification consumers continue receiving the exact expected artifact layout.

## Verification

- [ ] Demonstrate red tests for event redaction, fixed stage/role normalization and command boundary ordering.
- [ ] Implement diagnostic helper and runner wiring without altering subprocess settings or HTTP behavior.
- [ ] Exercise secret-bearing unknown values and fake raw child output; neither may appear in public records.
- [ ] Prove an interrupted begin-only run leaves a valid nonqualifying checkpoint; prove primary failure is captured before holds and diagnostic I/O failure preserves recovery handling.
- [ ] Confirm workflow uploads only the explicit progress file and retains current timeout/report/qualifier settings.
- [ ] Run focused tests, fresh read-only review, primary verification and full `npm run verify` with the validated external fixture parent on this Windows checkout.
- [ ] Commit and run one candidate CI after checks pass; inspect last observed boundaries rather than guessing the timed-out stage.

User authorization: continuation of approved Portal-only completion and concrete recovery-blocker correction. No VPS/n8n changes belong to this diagnostic block.
