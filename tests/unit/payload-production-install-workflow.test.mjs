import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('native B0 fixture and generated authenticated observation closure compile portably without execution', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-c', String.raw`
import ast,pathlib,re,types
source=pathlib.Path('tests/fixtures/payload-b0-native.py').read_text()
tree=ast.parse(source)
model=re.search(r'const observationModel = String.raw\x60([\s\S]*?)\x60;',pathlib.Path('tests/unit/payload-install-initializer.test.mjs').read_text()).group(1)
expression=next(node.value for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='adapter' for t in node.targets))
scope={name:'/fixture/'+name for name in ('model_path','fault_path','clock_path')}
scope['model_file']=types.SimpleNamespace(read_text=lambda:model)
adapter=eval(compile(ast.Expression(expression),'fixture-generator','eval'),scope)
compile(pathlib.Path('ops/payload-control-runtime.py').read_text()+adapter,'authenticated-native-fixture','exec')
`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('B0 native CI requires root positive CLI coverage and receipt resume cannot readmit', async () => {
  const [native, preparation, installer] = await Promise.all([
    readFile('.github/workflows/payload-b0-acceptance-check.yml', 'utf8'),
    readFile('tests/unit/payload-preparation-authentication.test.mjs', 'utf8'),
    readFile('.github/workflows/payload-install-production.yml', 'utf8'),
  ]);
  assert.match(native, /pull_request:[\s\S]*workflow_dispatch:/u);
  assert.match(native, /permissions:\n  contents: read/u);
  assert.match(native, /sudo -n \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/root/u);
  assert.match(native, /PAYLOAD_REQUIRE_NATIVE_PREPARATION=1 PAYLOAD_REQUIRE_NATIVE_TRUST=1/u);
  assert.match(native, /tests\/unit\/payload-preparation-authentication.test.mjs/u);
  assert.match(native, /'tests\/fixtures\/payload-b0-native.py'/u);
  assert.match(preparation, /native root B0 administrative capture[\s\S]*skip: process.env.PAYLOAD_REQUIRE_NATIVE_PREPARATION !== '1'/u);
  assert.match(preparation, /assert.equal\(process.getuid\(\), 0\)/u);
  assert.match(preparation, /actualCli: true, actualLease: true, actualJournal: true/u);
  assert.match(preparation, /resumeFieldsRejected: 19, sameNonceCandidateRejected: true, replacementLeaseRepairRejected: true/u);
  assert.match(native, /'tests\/unit\/payload-receiver-root.test.mjs'/u);
  assert.match(native, /tests\/unit\/payload-receiver-root.test.mjs \\/u);
  assert.match(preparation, /downstreamReadinessSimulated: true/u);
  assert.match(preparation, /privateInstallationQualified: false, restoreQualified: false/u);
  assert.doesNotMatch(native, /secrets\.|environment: production|docker |ssh |packages: write/u);
  assert.match(installer, /options: \[admit, resume\]/u);
  assert.match(installer, /if test "\$OPERATION" = admit; then[\s\S]*preflight=\$\(ssh[\s\S]*exit 0\n          fi\n          receipt="\$RECEIPT_ID"/u);
});

test('separate production installer is main/environment gated and can finish only installed-private', async () => {
  const workflow = await readFile('.github/workflows/payload-install-production.yml', 'utf8');
  const inputs = ['commit', 'run_id', 'run_attempt', 'api_image', 'cron_image', 'cms_image',
    'candidate_artifact_id', 'candidate_artifact_digest', 'candidate_sha256',
    'qualified_artifact_id', 'qualified_artifact_digest', 'qualified_sha256',
    'report_artifact_id', 'report_artifact_digest', 'report_sha256',
    'approval_sha256', 'inventory_identity', 'expires_at', 'nonce'];
  for (const input of inputs) assert.match(workflow, new RegExp(`^      ${input}:`, 'mu'));
  assert.equal((workflow.match(/^      [a-z0-9_]+:/gmu) || []).filter(line => inputs.includes(line.trim().slice(0, -1))).length, inputs.length);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /group: portal-ownerinc-production/u);
  assert.match(workflow, /VPS_USER" != root/u);
  assert.match(workflow, /production:payload-v2/u);
  assert.match(workflow, /"production:payload-resume-v3 \$receipt \$\{request#production:payload-v2 \}"/u);
  assert.doesNotMatch(workflow, /production:payload-apply-v2/u);
  const fields = /request="production:payload-v2 ([^\n]+)"/u.exec(workflow)?.[1];
  assert.ok(fields);
  assert.deepEqual([...fields.matchAll(/\$\{\{ inputs\.([a-z0-9_]+) \}\}/gu)].map(match => match[1]),
    ['commit', 'run_id', 'run_attempt', 'api_image', 'cron_image', 'cms_image',
      'candidate_artifact_id', 'qualified_artifact_id', 'report_artifact_id',
      'candidate_artifact_digest', 'qualified_artifact_digest', 'report_artifact_digest',
      'candidate_sha256', 'qualified_sha256', 'report_sha256',
      'approval_sha256', 'inventory_identity', 'expires_at', 'nonce']);
  assert.match(workflow, /status!=="installed-private"/u);
  assert.match(workflow, /authority!=="legacy"/u);
  assert.match(workflow, /routeReleased!==false/u);
  assert.doesNotMatch(workflow, /DATABASE_URL|POSTGRES_PASSWORD|CMS_OWNER_DATABASE_URL|status=live|authority.*payload/u);
});

test('candidate workflow scopes package publication and main-only candidate mode without install effects', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const preJobs = workflow.slice(0, workflow.indexOf('\njobs:'));
  assert.doesNotMatch(preJobs, /packages:\s*write/u);
  assert.equal((workflow.match(/packages:\s*write/gu) || []).length, 1);
  const validate = workflow.split('\n  validate:\n')[1].split('\n  publish-images:\n')[0];
  const publisher = workflow.split('\n  publish-images:\n')[1].split('\n  qualify-payload-candidate:\n')[0];
  assert.match(validate, /permissions:\n      contents: read/u);
  assert.doesNotMatch(validate, /packages:\s*write|docker login|docker push/u);
  assert.match(publisher, /needs: validate[\s\S]*permissions:\n      contents: read\n      packages: write/u);
  assert.match(publisher, /Download only the validated image bundle[\s\S]*Push validated immutable digests only/u);
  assert.doesNotMatch(publisher, /npm run verify|test:migrations|ssh |production:payload/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main' && inputs\.publish_candidate_only == true/u);
  assert.doesNotMatch(workflow, /startsWith\(github\.ref, 'refs\/heads\/'\) && inputs\.publish_candidate_only == true/u);
  const candidate = workflow.slice(workflow.indexOf('Capture complete immutable release candidate manifest'),
    workflow.indexOf('\n  deploy-production:'));
  assert.match(candidate, /schemaVersion: 2/u);
  assert.match(candidate, /approvalSha256/u);
  assert.match(candidate, /inventoryIdentity/u);
  assert.match(candidate, /expiresAt/u);
  assert.match(candidate, /nonce/u);
  assert.doesNotMatch(candidate, /ssh |sudo .*receiver|open-admission|authority transition/u);
});

test('candidate qualification emits every exact installer input as outputs, summary and a read-only handoff artifact', async () => {
  const [candidate, installer, generator] = await Promise.all([
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/payload-install-production.yml', 'utf8'),
    readFile('scripts/create-payload-install-dispatch.mjs', 'utf8'),
  ]);
  const inputs = [...installer.matchAll(/^      ([a-z0-9_]+): \{/gmu)].map(match => match[1]);
  assert.deepEqual(inputs, ['commit', 'run_id', 'run_attempt', 'api_image', 'cron_image', 'cms_image',
    'candidate_artifact_id', 'candidate_artifact_digest', 'candidate_sha256',
    'qualified_artifact_id', 'qualified_artifact_digest', 'qualified_sha256',
    'report_artifact_id', 'report_artifact_digest', 'report_sha256',
    'approval_sha256', 'inventory_identity', 'expires_at', 'nonce']);
  const qualifier = candidate.slice(candidate.indexOf('\n  qualify-payload-candidate:'), candidate.indexOf('\n  deploy-production:'));
  for (const input of inputs) {
    assert.match(qualifier, new RegExp(`^      ${input}: \\$\\{\\{ steps\\.install_handoff\\.outputs\\.${input} \\}\\}$`, 'mu'));
    assert.match(generator, new RegExp(`\\b${input}:`), `handoff must carry ${input}`);
  }
  for (const role of ['candidate', 'qualified', 'report']) {
    assert.match(qualifier, new RegExp(`${role.toUpperCase()}_ARTIFACT_DIGEST: \\$\\{\\{ steps\\.upload_`));
  }
  assert.match(qualifier, /name: payload-private-install-dispatch[\s\S]*path: install-dispatch\.json[\s\S]*if-no-files-found: error/u);
  assert.match(generator, /GITHUB_STEP_SUMMARY[\s\S]*never infer a value[\s\S]*payload-install-production\.yml/u);
  assert.match(generator, /validateQualifiedCandidate/u);
  assert.match(generator, /`sha256:\$\{artifactDigests\[role\]\}`/u,
    'raw upload-artifact outputs must be normalized to the GitHub API digest form');
  assert.doesNotMatch(generator, /secrets\.|PORTAL_VPS_|SSH_PRIVATE_KEY|GITHUB_TOKEN/u);
});
