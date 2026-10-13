import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const runner = readFileSync('scripts/test-payload-preauthority-recovery.mjs', 'utf8');

test('candidate-only outer budget covers measured prefix, existing coordinator caps and explicit reserves', () => {
  const jobExpression = workflow.match(/  validate:\n    timeout-minutes: (.+)/)?.[1];
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
  const coordinator = runner.slice(runner.indexOf('function coordinator('), runner.indexOf('function coordinator(') + 1600);
  const coordinatorCap = Number(coordinator.match(/timeout: (\d+) \* 60_000/)?.[1]);
  assert.equal(coordinatorCap, 15, 'inner coordinator cap must not be raised');
  const remaining = runner.slice(runner.indexOf("setStage('first_actual_restore')"), runner.indexOf('safeChecks.repeatedCaptureRestoreAfterLiveEdit = true'));
  assert.deepEqual([...remaining.matchAll(/coordinator\((target|source), \1\.project, '(restore|backup)'/g)].map(m => m[2]), ['restore', 'backup', 'restore']);
  assert.match(remaining, /assertRecoverySnapshots\(sourceAfter, targetAfter\)/);
  assert.match(remaining, /assertRecoverySnapshots\(secondSourceAfter, secondTargetAfter\)/);
  assert.ok(recoveryMinutes >= observedPrefixMinutes + 3 * coordinatorCap + 24.7);
  assert.ok(candidateMinutes - recoveryMinutes >= 30);
  assert.ok(candidateMinutes - recoveryMinutes - observedOutsideRecoveryMinutes >= 20);
  assert.match(workflow, /  deploy-production:[\s\S]*?timeout-minutes: 25/);
  assert.deepEqual([...workflow.matchAll(/^        timeout-minutes: (\d+)$/gm)].map(m => Number(m[1])), [5, 15, 10, 15, 120]);
});
