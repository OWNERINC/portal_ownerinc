# Preparation inherited reaper Implementation Plan

## Steps
- [ ] Implement the dedicated surviving test reaper and portable contract regressions.
- [ ] Wire both workloads into the existing preparation test without changing its inventory.
- [ ] Complete primary verification, fresh review and exact-package verification/publication.
- [ ] Execute native CI through the unchanged qualification supervisor and record the result.

> **For agentic workers:** use the existing Sol Advisor implementation lane with one bounded implementer and fresh read-only review. Primary owns documentation, extraction, index, publication and CI. The user delegated continuous Astra xhigh technical decisions and implementation; independent A/B analysis and exactly one cross-critique are complete. This is a separate behavioral harness correction after the diagnostic-only increment, not a revision of that increment's constraints.

**Goal:** make the inherited-group preparation test prove real termination and reaping under the actual nested CI subreaper topology.

**Architecture:** a test-only Python subreaper survives outside the group killed by the unchanged production helper. It collects the leader through its sole Popen owner, then collects the expected adopted descendants. Success requires creation and kernel wait evidence without helper-originated rescue; cleanup after failure cannot change that failure to success.

**Tech Stack:** Python standard library, Node built-in tests, Node 18-compatible shared test syntax; Linux process qualification exclusively in CI.

## Primary synthesis

### Decision suggested

Use the dedicated test-local reaper. Shared concurrent reaping would require redesigning Popen/status ownership, pipe handling and multiple fixture consumers. Increasing the passive PID poll or accepting zombies would not establish reaping. Neither alternative enters this increment.

### Proven facts

- Run `41572434705` on `512773c` emitted complete, explicitly unauthenticated TAP observation: 31 tests, 30 PASS, 1 FAIL, 0 SKIP; fixed failed ID `preparation.inherited-group`.
- The existing test launches a detached Python supervisor, which calls the real `run_bounded_subprocess` in inherited mode. Failure deliberately kills that supervisor's own process group.
- Production code explicitly relies on a surviving receiver outside that group. The test instead passively probes a nested PID while the outer CI subreaper waits for the complete Node suite before reaping.
- The shared CI cleanup is active termination plus reaping, so invoking it during successful observation could conceal an actual surviving child.

### Unconfirmed hypotheses

The missing timely reaper is an independently established harness-topology defect. The run's precise assertion, scenario, process state and kernel adoption sequence remain unknown. Historical failures are not reattributed. A diagnostic field `supervisor=absent` describes absence of the fixed stderr marker, not absence of a supervisor.

### Resolved divergences

Both reviewers accepted the same three-code-file scope. Mandatory post-reap signal-zero checks were rejected: a successful owned wait is stronger evidence and a freed PID may be reused. Branch-causal overflow proof was also rejected for this increment: retain both workloads and the real production limits, but do not infer which internal condition initiated SIGKILL. No new timing threshold or production instrumentation is required.

### Residual risks

Startup scheduling, process adoption, private creation receipts and bounded failure cleanup need fresh native evidence. Missing ownership, missing expected wait receipts, surviving children, unexpected statuses or exhausted cleanup prevent PASS. An outer rescue does not satisfy this fixture's cleanup proof.

### Verification plan and conditions for implementation

Use portable doubles around the actual helper state machine, then primary repetition, fresh review and exact-package `npm run verify`. Publish only that accepted package. Native CI must run the unchanged recovery supervisor and qualification assertions, with preparation 31 PASS /0 FAIL /0 SKIP. Broader fixtures may still fail independently. Continuous user authorization covers this bounded test correction; production helpers, privileges, B0 contracts and shared supervision stay protected.

## Global Constraints

- Exactly three code/test files below; primary may add this plan and update the consolidated evidence report.
- Preserve all 31 preparation test names, order and top-level declarations. No nested Node subtests.
- Preserve the Linux skip condition on the existing inherited-group test.
- Preserve both `timeout` and `overflow` workloads and real `run_bounded_subprocess(..., 1024, 1, group_mode='inherit')` invocation.
- Preserve the Node `spawnSync` 15,000 ms guard per workload; invoke the helper once per workload.
- Each helper has one absolute monotonic deadline at most 12 seconds from entry, including failure cleanup, leaving margin before the outer guard. Phases cannot renew it.
- Descendant success observation after leader collection lasts at most two seconds, bounded also by the invocation deadline. Reserve at least five seconds of the 12-second envelope for failure cleanup.
- No production `group_mode='new'` cleanup wrapper on the success path; no helper-originated signals before success is determined impossible.
- No raw PID, PGID, start identity, wait status, path, stdout/stderr, exception, assertion message or traceback in emitted fixture output.
- Native processes/services are CI-only. Portable checks may execute Python with fake operations; compilation/import must not spawn native children or enable subreaping.
- Protect `ops/`, shared recovery supervisor/wrapper, workflows, attribution helper/inventory, PG16 driver, browser and all unrelated WIP.

## Files and interfaces

1. Create `tests/fixtures/payload-preparation-inherited-group.py` — import-safe standard-library helper and actual reaper state machine.
2. Modify `tests/unit/payload-preparation-authentication.test.mjs` — only the existing inherited-group test body, preserving its declaration/condition.
3. Create `tests/unit/payload-preparation-inherited-group.test.mjs` — portable helper-control-flow, privacy, wiring and syntax regressions outside the 31-test inventory.

The Python public interface is `run_scenario(scenario, operations=None)`. With no injected operations, it uses the real Linux adapter; injected operations exercise the same control flow without real native spawning. `main(argv)` accepts exactly one of `timeout` or `overflow`; the production source path is derived from this helper's repository location, not an arbitrary CLI command. Imports perform no native work. Keep the adapter small and the state machine directly testable.

Return and emit exactly this fixed JSON shape, populated only with a validated scenario and actual boolean outcomes:

```json
{"kind":"preparation-inherited-reaper-v1","scenario":"timeout","passed":true,"cleanupVerified":true,"workloadObserved":true,"leaderSignaled":true,"descendantsReaped":true,"rescueUsed":false}
```

Exit 0 requires all four proof/cleanup booleans true, `passed=true`, and `rescueUsed=false`. A refused or failed scenario emits the same bounded shape with `passed=false` and exits 1. Invalid CLI arguments exit 2 with a fixed message or no output. Never print an exception. This is test evidence, not authenticated production approval or proof of the internal timeout/overflow branch.

## Task 1 — surviving reaper and owned cleanup

Enable Linux subreaping before spawning the leader. The leader creates its own session/group; the helper stays outside. Give the leader external stdin/stdout/stderr DEVNULL, while retaining the production helper's internal bounded output pipe. The leader imports the unchanged production module and runs the selected original workload. Private fixture-owned records must establish creation of both the runtime-like direct child and nested sleeper before those records can qualify expected wait receipts. Validate bounded exact record fields and distinct positive identities; use a private temporary directory and fixed filenames. Record the selected workload's start, not a claimed production trigger.

Preserve one waiter per child:

```python
leader_status = leader.wait(timeout=remaining_leader_window)
leader_signaled = leader_status == -signal.SIGKILL
```

Only after the Popen owner collects the leader may the helper use adopted-child `waitpid(-1, os.WNOHANG)`. Require successful waits for the two expected descendants, with the expected SIGKILL terminal outcome, and eventually `ChildProcessError`. Unknown additional children or missing expected receipts prevent PASS, even if the child scope later empties. A wait result of zero means children still exist; state `Z` is never accepted as reaped. Do not signal or probe an already reaped numerical PID.

Set sticky failure before any rescue. If the leader remains outstanding, only its Popen object may poll, kill and wait for it. After leader collection, discover bounded direct children using the helper's own Linux task children inventory. Confirm each still belongs to this helper using a nonblocking exact-PID wait before signaling:

```python
try:
    collected, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    continue
if collected == 0:
    os.kill(pid, signal.SIGKILL)
```

This fragment is only the rescue ownership rule: the real state machine must preserve its deadline, collect statuses, and never signal a PID after a successful wait. With a single waiter, a child that exits after a zero result stays unreaped, pinning its PID until this helper collects it. Never use a PID-file value or remembered group number as rescue authority. Repeat bounded discovery/reaping as deeper descendants are adopted. Empty procfs output is insufficient; require eventual ECHILD. Discovery, permission, identity or wait errors remain failures. Catchable interruptions enter the same bounded sticky-failure path; do not swallow fatal inability to clean up into PASS.

Use fixed phase cutoffs within the initial 12-second deadline: leader observation no later than entry+5 seconds; descendant observation no later than leader collection+2 seconds and entry+7 seconds; rescue ends no later than entry+12 seconds. Poll sleeps, if used, are short and capped by remaining time. No unbounded waits, pipe reads, retries or renewed budgets. Native adapter records must be bounded and private; final output is only the fixed projection above.

## Task 2 — preserve preparation inventory and run both workloads

Replace only the inherited-group body with two bounded helper invocations. Each uses `python -I -S -B tests/fixtures/payload-preparation-inherited-group.py SCENARIO`, encoding UTF-8 and timeout 15,000 ms. Collect sanitized outcome booleans for both iterations before a single assertion. A failure or malformed first result must not prevent the second invocation; do not interpolate raw output into assertions.

Success validation must require no spawn error, no signal, exit zero, empty stderr, bounded stdout, exact keys, exact kind/scenario and exact success booleans. Parse exceptions become false; any output property beyond the schema is rejected. The final assertion uses only a fixed message and boolean outcomes, never the returned child data. Remove passive PID polling and PIDfile-only absence assertions; actual kernel wait receipts replace them with stronger proof.

The helper must not skip on a supported Linux invocation. The existing test's platform skip remains the only compatibility skip. Both original workload bodies remain recognizable, including the nested sleeper and overflowing writer, and both use the unchanged real inherited helper.

## Task 3 — portable tests and primary acceptance

The new Node test file should invoke Python with an embedded unittest program that imports the helper and supplies fake process, clock, wait, signal and private-record operations. It must call the real `run_scenario` logic, not an independently reimplemented algorithm. Required cases:

- Subreaper-before-spawn and new-session leader; external stdio cannot retain helper pipes.
- Popen solely owns the leader until collected; adopted waits start afterward.
- Each workload's valid receipts + SIGKILL waits + ECHILD succeeds without a rescue signal.
- Missing/malformed/duplicate/foreign creation records, wrong leader/descendant outcomes and unexpected children refuse.
- Zero wait results cannot become success; zombies require actual waits; no signal occurs after a successful reap.
- Exact-PID wait confirming a live owned child precedes rescue signaling; ECHILD or ownership errors never authorize a signal.
- New adoption during cleanup is collected; cleanup exhaustion, persistent wait errors and interruption remain bounded failures.
- Successful rescue leaves `passed=false` and `rescueUsed=true`.
- Absolute clocks do not renew budgets; per-phase observation and cleanup caps are enforced.
- CLI and Node assertion output reject private canaries, paths, PIDs, arbitrary messages and malformed result fields.
- Actual Node wiring attempts both helper scenarios after an initial failure, with unchanged limits and no additional preparation declarations.
- Python source and generated leader/workload strings compile without running native processes; import itself has no process or filesystem effects.

Run on this Windows checkout with native flags absent:

```text
node --test tests/unit/payload-preparation-inherited-group.test.mjs tests/unit/payload-preparation-attribution.test.mjs tests/unit/payload-preparation-authentication.test.mjs tests/unit/payload-production-recovery.test.mjs
```

On Linux, the inherited preparation suite and some root fixtures run native code even without opt-in; do not use that command outside authorized CI. Worker reports all exact changed-file hashes, counts/skips, LF and whitespace checks. Primary repeats focused checks and confirms only the inherited test body changed. Fresh read-only reviewer assesses actual source and proof. Extract exactly the three code files plus this plan onto published HEAD, run required full `npm run verify` there, and publish selectively without staging unrelated WIP.

Native acceptance is a new run through the unchanged CI supervisor: complete ordered preparation TAP 31 PASS /0 FAIL /0 SKIP, both workload success projections grounded in real waits and no rescue; original detached-process proof and cleanup gates remain required. Downstream ADMIN/PG/application/witness failures remain independent failures and must be recorded rather than hidden. A successful repair does not retroactively prove the historical zombie hypothesis.
