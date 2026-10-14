import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const runner = readFileSync('scripts/test-payload-preauthority-recovery.mjs', 'utf8');

test('candidate-only outer budget covers measured prefix, existing coordinator caps and explicit reserves', () => {
  const jobExpression = workflow.match(/  validate:\n[\s\S]*?    timeout-minutes: (.+)/)?.[1];
  assert.equal(jobExpression, "${{ github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.publish_candidate_only == true && inputs.cms_image_only != true && 150 || 90 }}");
  const step = workflow.split('      - name: Run disposable four-store preauthority recovery on published digests\n')[1]?.split('      - name:')[0];
  assert.ok(step);
  assert.match(step, /if: github.event_name == 'workflow_dispatch' && startsWith\(github.ref, 'refs\/heads\/'\) && inputs.publish_candidate_only == true && inputs.cms_image_only != true/);
  const recoveryMinutes = Number(step.match(/timeout-minutes: (\d+)/)?.[1]);
  const candidateMinutes = Number(jobExpression.match(/&& (\d+) \|\|/)?.[1]);
  assert.equal(recoveryMinutes, 120);
  // CI 38454684188: observed prefix, not an expected successful duration.
  const observedPrefixMinutes = 50.3;
  const observedOutsideRecoveryMinutes = 9.32;
  const pg16Step = workflow.split('      - name: Qualify legacy security observer with isolated PostgreSQL 16\n')[1]?.split('      - name:')[0];
  assert.ok(pg16Step);
  const pg16Minutes = Number(pg16Step.match(/timeout-minutes: (\d+)/)?.[1]);
  assert.equal(pg16Minutes, 6);
  const coordinator = runner.slice(runner.indexOf('function coordinator('), runner.indexOf('function coordinator(') + 1600);
  const coordinatorCap = Number(coordinator.match(/timeout: (\d+) \* 60_000/)?.[1]);
  assert.equal(coordinatorCap, 15, 'inner coordinator cap must not be raised');
  const remaining = runner.slice(runner.indexOf("setStage('first_actual_restore')"), runner.indexOf('safeChecks.repeatedCaptureRestoreAfterLiveEdit = true'));
  assert.deepEqual([...remaining.matchAll(/coordinator\((target|source), \1\.project, '(restore|backup)'/g)].map(m => m[2]), ['restore', 'backup', 'restore']);
  assert.match(remaining, /assertRecoverySnapshots\(sourceAfter, targetAfter\)/);
  assert.match(remaining, /assertRecoverySnapshots\(secondSourceAfter, secondTargetAfter\)/);
  assert.ok(recoveryMinutes >= observedPrefixMinutes + 3 * coordinatorCap + 24.7);
  assert.ok(candidateMinutes - recoveryMinutes >= 30);
  const fenceStep = workflow.split('      - name: Qualify isolated Portal fence topology\n')[1]?.split('      - name:')[0];
  assert.ok(fenceStep);
  const fenceMinutes = Number(fenceStep.match(/timeout-minutes: (\d+)/)?.[1]);
  assert.equal(fenceMinutes, 6);
  // Both six-minute gates consume existing headroom. Historical durations are
  // observations, not successful-run timing guarantees (remaining: 8.68 min).
  assert.ok(candidateMinutes - recoveryMinutes - observedOutsideRecoveryMinutes - pg16Minutes - fenceMinutes >= 8);
  assert.match(workflow, /  deploy-production:[\s\S]*?timeout-minutes: 25/);
  assert.deepEqual([...workflow.matchAll(/^        timeout-minutes: (\d+)$/gm)].map(m => Number(m[1])), [5, 6, 5, 15, 6, 6, 10, 15, 120]);
});

test('B0 prerequisite is separately capped, required natively, and does not skip ordinary validation', () => {
  const b0 = workflow.split('  isolated-b0-recovery:\n')[1].split('  validate:\n')[0];
  assert.match(b0, /timeout-minutes: 12/);
  assert.match(b0, /persist-credentials: false/);
  assert.match(b0, /ref: \$\{\{ github.sha \}\}/);
  assert.match(b0, /permissions:\n      contents: read/);
  assert.doesNotMatch(b0, /secrets\.|services:|continue-on-error|docker (?:rm|stop)|systemctl restart/);
  assert.match(b0, /sudo -n env -i PATH="\$PATH" HOME=\/root/);
  assert.match(b0, /PAYLOAD_REQUIRE_NATIVE_B0_RECOVERY=1 PAYLOAD_B0_RECOVERY_DISPOSABLE=1/);
  assert.match(b0, /node --test tests\/unit\/payload-install-recovery.test.mjs/);
  const candidate = "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.publish_candidate_only == true && inputs.cms_image_only != true";
  assert.ok(b0.includes(`if: ${candidate}`));
  const gate = workflow.split('  validate:\n')[1].split('\n    timeout-minutes:')[0];
  assert.equal(gate, `    needs: isolated-b0-recovery\n    if: \${{ !cancelled() && (needs.isolated-b0-recovery.result == 'success' || (!(${candidate}) && needs.isolated-b0-recovery.result == 'skipped')) }}`);
  // Evaluate the exact expression after substituting GitHub context references.
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) for (const publish of [false, true]) for (const cms of [false, true]) {
    const selected = event === 'workflow_dispatch' && publish && !cms;
    for (const cancelled of [false, true]) for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
      const expression = gate.split('if: ${{ ')[1].split(' }}')[0]
        .replaceAll('!cancelled()', String(!cancelled)).replaceAll('needs.isolated-b0-recovery.result', JSON.stringify(result))
        .replaceAll('github.event_name', JSON.stringify(event)).replaceAll("startsWith(github.ref, 'refs/heads/')", 'true')
        .replaceAll('inputs.publish_candidate_only', String(publish)).replaceAll('inputs.cms_image_only', String(cms));
      assert.equal(Function(`return (${expression})`)(), !cancelled && (result === 'success' || (!selected && result === 'skipped')));
    }
  }
  assert.match(workflow, /name: Reject conflicting publication modes\n        if: github.event_name == 'workflow_dispatch' && inputs.cms_image_only == true && inputs.publish_candidate_only == true/);
});
