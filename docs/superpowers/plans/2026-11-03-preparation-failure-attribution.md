# Preparation failure attribution Implementation Plan

## Steps
- [x] Add the bounded diagnostic projection and offline privacy/inventory regressions.
- [x] Wire failure-only emission before unchanged native preparation assertions.
- [ ] Complete primary verification, fresh review and exact-package verify/publication.

> **For agentic workers:** use the existing Sol Advisor implementation lane with one bounded implementer and a fresh read-only reviewer. Primary owns verification, documentation, extraction, index, commits and CI. The user delegated Astra xhigh technical decisions and continuous implementation; the completed A/B analysis and one cross-critique authorize this diagnostic-only increment without another execution-choice interview.

**Goal:** identify observed failing preparation test IDs when complete child TAP is available, while retaining opaque outcomes otherwise.

**Architecture:** a pure helper validates the complete bounded TAP inventory and projects fixed public metadata. The existing recovery test invokes it only when its existing preparation checks would fail. Neither the helper nor its output participates in qualification decisions.

**Tech Stack:** Node built-ins and dependency-free Node tests; Node 18-compatible shared syntax.

## Decision and evidence

Runs 41565057241 (`8ebfdf8`) and 41566878521 (`75a83b8`) fail at the preparation subprocess status assertion. Their inner test or supervisor cause is not known. Both independent investigations found a source-level ordering conflict: the inherited-group test kills its owning Python process, while the outer subreaper waits for the Node suite before reaping adopted descendants. Signal-zero can still find unreaped zombie PIDs. This mechanism is a candidate, not attributed run evidence.

The first run's 56.590 seconds cover the aggregate qualification test including process proof. The subprocess cap is 420 seconds; 60 seconds is minimum remaining budget for admission. Neither value identifies an inner test. Workflow emergency cleanup does not establish complete cleanup of every preparation namespace.

Alternatives considered: change supervision now (premature attribution); add supervisor phase instrumentation (larger scope); project already-captured TAP (selected minimum). A future behavioral repair requires observed evidence. No zombie-as-success, extra sleeps, removal of subreaping or weakened cleanup assertions.

## Global Constraints

- Preserve every existing preparation invocation argument, environment, timeout, admission minimum, assertion and cleanup operation.
- Preserve all 31 top-level preparation tests, native zero-skip requirements and nine-field B0 identity constraints.
- No edits to preparation tests, supervisor, production Python, workflow, privileges or deadline behavior.
- No raw TAP/stderr, test names, paths, PIDs, commands, errors, tracebacks, assertions or private canaries in emitted output.
- Diagnostics are observed text, not authenticated causal receipts or acceptance evidence. A forged complete conforming stdout cannot be authenticated by text parsing.
- Source/worker/primary/exact-package/native evidence remain distinct. Native execution is CI-only; no Docker Desktop or local stack.
- Preserve unrelated owner/CMS/lifecycle/browser work. No worker index, commit, dependency or service operations.

## Files and interfaces

1. Create `tests/helpers/payload-preparation-attribution.mjs`: pure projection and fixed formatter; no subprocesses, filesystem reads, environment reads or connections.
2. Create `tests/unit/payload-preparation-attribution.test.mjs`: parser/privacy/process-shape/inventory regressions.
3. Modify `tests/unit/payload-production-recovery.test.mjs`: import helper and emit `t.diagnostic` before the existing preparation assertions, only on their failure conditions.

The helper exports `projectPreparationFailure(result)` and `formatPreparationFailure(projection)`. The projector returns a frozen data-only record with fixed enums for process outcome, TAP validity and generic supervisor marker, bounded numeric counts, and fixed failed/skipped/todo IDs only when the entire TAP is valid. Invalid or incomplete streams expose no test IDs. The formatter emits only a projector-created snapshot (WeakMap/WeakSet binding), not arbitrary caller objects.

Suggested closed enums: process `exit-zero`, `exit-nonzero`, `signal`, `spawn-error`, `unknown`; TAP `complete`, `incomplete`, `invalid`; supervisor marker `reported`, `absent`, `unknown`. No phase/cause is inferred from the generic supervisor marker.

## Task 1 — safe projection

Read the actual 31 declarations and map each literal name to a unique fixed public ID in source. The guard test must compare the complete ordered map with those actual declarations; checking only length is insufficient.

Accept only primitive strings and expected own data properties. Reject proxies before descriptor inspection, accessors, hostile getters and coercible values. Do not read or serialize error properties. Bound stdout/stderr length, line count and line length before processing. Suggested caps: stdout 2 MiB, stderr 4 KiB, 32,768 lines, 16 KiB per line; larger input produces a fixed invalid/incomplete observation without excerpts.

Require an anchored closed grammar for all 31 top-level records in their expected numbering/order, exact literal names, one complete plan and consistent terminal numeric counts. Only exact numeric summary comments participate in consistency. Ignore ordinary comments, nested records and indented diagnostic/YAML content as identity sources. Reject unknown/duplicate/out-of-order records, unsupported directives, contradictory plans/counts, unclosed diagnostic regions, truncation and extra top-level material. Supported SKIP/TODO records can be observed but never accepted by the native gate.

Recognize only the whole exact supervisor message `Native qualification supervision failed; private diagnostics withheld.` with its actual single line ending. A matching message reports the generic wrapper marker, not its phase. Missing or conflicting process fields yield `unknown`; a nonzero status alone does not imply an inner-test failure. Conflicting complete TAP and wrapper marker yields unknown attribution without IDs.

Regression examples (using actual helper-generated fixture constructors in the new test):

```js
assert.deepEqual(projectPreparationFailure(withPrivateYaml(validFailureTap)).failedIds,
  ['preparation.inherited-group']);
assert.deepEqual(projectPreparationFailure(withDuplicateResult(validFailureTap)).failedIds, []);
assert.deepEqual(projectPreparationFailure(withTruncatedPlan(validFailureTap)).failedIds, []);
assert.doesNotMatch(formatPreparationFailure(projectPreparationFailure(hostileResult)),
  /PRIVATE_CANARY|secret-path|AssertionError/u);
```

Use complete literal inventory streams for one failure, multiple failures, skip, todo and all-pass. Cover comments/indented payload injection, whole-stream extra records, huge inputs, contradictory process fields, getters, proxies and objects with coercion/toJSON traps. A real tiny offline Node TAP child may ground supported syntax; no services are needed.

## Task 2 — failure-only wiring

Use exactly the existing failure predicates before the untouched assertions:

```js
if (preparation.error?.code !== undefined || preparation.status !== 0
  || !/# skipped 0\b/u.test(preparation.stdout) || !/# fail 0\b/u.test(preparation.stdout)) {
  t.diagnostic(formatPreparationFailure(projectPreparationFailure(preparation)));
}
```

The existing native test callback takes no argument; add its test context parameter `t` for the diagnostic call. Preserve the four original assertion lines verbatim. The condition uses the actual trusted `nativeRun` result and matches the original predicates; the pure projector separately enforces hostile-input handling. The projection never replaces these predicates or changes process status, proof/report creation, subsequent fixture order or cleanup. Emission failure must not mask the original assertion failure; catch only the diagnostic call if needed and retain a fixed fallback.

## Task 3 — acceptance

Worker: run the new offline suite and recovery wrapper tests with native opt-in absent, syntax and scoped whitespace checks. Report exact changed-file hashes, test counts and unchanged original assertion/invocation evidence. Primary repeats focused checks, reviews the actual diff, requests fresh read-only review, then extracts only these files plus this plan on the published base. Run `npm run verify` against that exact isolated package before selective publication. CI rerun remains a separate native gate; unknown attribution is a valid fail-closed result and never a qualification PASS.
