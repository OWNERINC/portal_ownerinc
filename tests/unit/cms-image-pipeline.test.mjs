import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function namedStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

function containingStep(workflow, marker) {
  const index = workflow.indexOf(marker);
  assert.notEqual(index, -1, `missing workflow marker: ${marker}`);
  const start = workflow.lastIndexOf('      - ', index);
  const end = workflow.indexOf('\n      - ', index);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

function condition(block, indentation) {
  const prefix = `${' '.repeat(indentation)}if: `;
  const line = block.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  assert.ok(line, `missing if condition at indentation ${indentation}`);
  const value = line.slice(prefix.length);
  if (value !== '>-') return value;

  const marker = `${prefix}>-\n`;
  const start = block.indexOf(marker);
  const contentIndent = ' '.repeat(indentation + 2);
  const lines = block.slice(start + marker.length).split(/\r?\n/);
  const expression = [];
  for (const line of lines) {
    if (!line.startsWith(contentIndent)) break;
    expression.push(line.trim());
  }
  return expression.join(' ');
}

test('CI keeps CMS-only, normal main, and API-v2 release-candidate publication modes isolated', async () => {
  const [workflow, dockerfile, deployment] = await Promise.all([
    read('.github/workflows/ci.yml'), read('cms/Dockerfile'), read('docs/operations/deployment.md'),
  ]);
  const build = namedStep(workflow, 'Build production images');
  const conflict = namedStep(workflow, 'Reject conflicting publication modes');
  const integration = namedStep(workflow, 'Test editorial admin session v2 against disposable PostgreSQL and Firebase Auth');
  const failureReport = namedStep(workflow, 'Upload redacted API-v2 failure report');
  const scan = namedStep(workflow, 'Scan CMS image');
  const publish = namedStep(workflow, 'Publish immutable images');
  const publishCms = namedStep(workflow, 'Publish CMS immutable image');
  const candidateManifest = namedStep(workflow, 'Capture complete immutable release candidate manifest');
  const recoveryPull = namedStep(workflow, 'Pull exact published candidate image digests for root-owned fixture');
  const recovery = namedStep(workflow, 'Run disposable four-store preauthority recovery on published digests');
  const recoveryReport = namedStep(workflow, 'Upload redacted preauthority recovery report');
  const qualifiedManifest = namedStep(workflow, 'Create recovery-qualified candidate manifest');
  const authenticate = namedStep(workflow, 'Authenticate to GHCR');
  const apiPublishAt = workflow.indexOf('      - name: Publish immutable images');
  const publishAt = workflow.indexOf('      - name: Publish CMS immutable image');
  const scanAt = workflow.indexOf('      - name: Scan CMS image');
  const buildAt = workflow.indexOf('      - name: Build production images');
  const integrationAt = workflow.indexOf('      - name: Test editorial admin session v2 against disposable PostgreSQL and Firebase Auth');
  const normalMainCondition = "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && inputs.cms_image_only != true && inputs.publish_candidate_only != true";
  const cmsOnlyCondition = "(github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.cms_image_only == true && inputs.publish_candidate_only != true)";
  const candidateExpression = "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.publish_candidate_only == true && inputs.cms_image_only != true";
  const candidateCondition = `(${candidateExpression})`;
  const cmsPublishCondition = `((${normalMainCondition}) || ${cmsOnlyCondition} || ${candidateCondition})`;
  const apiPublishCondition = `((${normalMainCondition}) || ${candidateCondition})`;

  assert.ok(workflow.indexOf('      - name: Reject conflicting publication modes') < workflow.indexOf('      - uses: actions/checkout@'),
    'conflicting flags must fail before checkout, build, test or publication');
  assert.match(workflow, /publish_candidate_only:\n\s+description:[^\n]*\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    'candidate publication must be an opt-in default-false boolean input');
  assert.match(conflict, /inputs\.cms_image_only == true && inputs\.publish_candidate_only == true[\s\S]*exit 1/,
    'the two manual publication modes must fail closed when selected together');
  assert.ok(buildAt < integrationAt && integrationAt < scanAt && scanAt < publishAt,
    'candidate API-v2 HTTP acceptance must run after image build and before scans/publication');
  assert.ok(apiPublishAt < publishAt &&
    publishAt < workflow.indexOf('      - name: Capture complete immutable release candidate manifest') &&
    workflow.indexOf('      - name: Capture complete immutable release candidate manifest') < workflow.indexOf('      - name: Run disposable four-store preauthority recovery on published digests') &&
    workflow.indexOf('      - name: Pull exact published candidate image digests for root-owned fixture') < workflow.indexOf('      - name: Run disposable four-store preauthority recovery on published digests') &&
    workflow.indexOf('      - name: Run disposable four-store preauthority recovery on published digests') < workflow.indexOf('      - name: Create recovery-qualified candidate manifest'),
    'recovery qualification must follow all same-SHA candidate publication and actual-digest capture');
  assert.equal(condition(integration, 8), candidateExpression);
  assert.match(integration, /NODE_ENV: test[\s\S]*MIGRATION_TEST_DISPOSABLE: "true"[\s\S]*PORTAL_TEST_API_IMAGE: ownerinc-portal-api:\$\{\{ github\.sha \}\}[\s\S]*PORTAL_TEST_FIREBASE_PROJECT_ID: demo-ownerinc-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
    'candidate acceptance must use a commit-matched API image and run-unique Firebase demo project');
  assert.match(integration, /node scripts\/test-editorial-admin-session-integration\.mjs/);
  assert.match(failureReport, /always\(\)[\s\S]*failure\(\)[\s\S]*name: editorial-admin-session-failure-report[\s\S]*editorial-admin-session-report\.json[\s\S]*if-no-files-found: ignore/,
    'only the redacted report file may be uploaded as failure evidence');

  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+cms_image_only:\n\s+description:[^\n]*\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    'the opt-in CMS-only dispatch must be a default-false boolean input');
  assert.match(build, /docker build --tag ownerinc-portal-cms:\$\{GITHUB_SHA\} --file cms\/Dockerfile \./,
    'CMS Dockerfile must be built with the repository-root context');
  assert.doesNotMatch(build, /--build-arg|CMS_BUILD_ONLY|secrets\./,
    'production CMS image build must not receive build-time secrets or the synthetic CI build flag');
  assert.match(dockerfile, /RUN node --import tsx scripts\/check-runtime-packaging\.mjs/,
    'the existing final-runtime packaging closure check must run as part of the production image build');

  assert.match(scan, /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(scan, /image-ref: ownerinc-portal-cms:\$\{\{ github\.sha \}\}/);
  assert.match(scan, /severity: HIGH,CRITICAL[\s\S]*ignore-unfixed: true[\s\S]*exit-code: 1/);

  assert.match(workflow, /cms_image: \$\{\{ steps\.publish_cms\.outputs\.cms_image \}\}/,
    'the CMS-only publication step must expose its digest as a validate job output');
  assert.match(workflow, /api_image: \$\{\{ steps\.publish\.outputs\.api_image \}\}/);
  assert.match(workflow, /cron_image: \$\{\{ steps\.publish\.outputs\.cron_image \}\}/);
  assert.equal(condition(authenticate, 8), cmsPublishCondition,
    'GHCR authentication must be limited to normal main, CMS-only, or validated candidate publication');
  assert.equal(condition(publish, 8), apiPublishCondition,
    'API/cron publication must include branch candidates but stay disabled in CMS-only mode');
  const legacyPublishCommands = publish.match(/        run: \|\n([\s\S]*)$/)?.[1] || '';
  assert.doesNotMatch(legacyPublishCommands, /ownerinc-portal-cms|cms_image|cms-image/,
    'the legacy publisher must publish only API and cron');
  assert.equal(condition(publishCms, 8), cmsPublishCondition,
    'CMS publication may run on normal main, CMS-only, or validated candidate dispatch');
  assert.match(publishCms, /docker tag ownerinc-portal-cms:\$\{GITHUB_SHA\} \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publishCms, /docker push \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publishCms, /cms_image=\$\(docker inspect --format='\{\{index \.RepoDigests 0\}\}' \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}\)/);
  assert.match(publishCms, /\^ghcr\\\.io\/ownerinc\/ownerinc-portal-cms@sha256:\[0-9a-f\]\{64\}\$/,
    'only the complete expected GHCR repository@sha256 reference may be exported');
  assert.match(publishCms, /printf '%s\\n' "\$cms_image" > cms-image-digest\.txt/);
  assert.match(publishCms, /printf '%s\\n' "\$GITHUB_SHA" > cms-image-source\.txt/);
  assert.match(publishCms, /echo "cms_image=\$cms_image" >> "\$GITHUB_OUTPUT"/);
  assert.match(publish, /api_image=\$\(docker inspect[^\n]*ownerinc-portal-api/);
  assert.match(publish, /cron_image=\$\(docker inspect[^\n]*ownerinc-portal-cron/);
  assert.match(publish, /printf '%s\\n%s\\n' "\$api_image" "\$cron_image" > image-digests\.txt/,
    'the legacy release digest file must remain exactly API and cron');

  const upload = containingStep(workflow, 'name: cms-image-digest');
  assert.equal(condition(upload, 8), cmsPublishCondition);
  assert.match(upload, /path:[\s\S]*cms-image-digest\.txt[\s\S]*cms-image-source\.txt/);
  const legacyUpload = containingStep(workflow, 'name: image-digests');
  assert.equal(condition(legacyUpload, 8), normalMainCondition);
  assert.match(legacyUpload, /path: image-digests\.txt/);
  assert.doesNotMatch(legacyUpload, /cms-image|cms_image(?!_only)/,
    'CMS metadata must not alter the existing API/cron digest artifact');

  const productionDeploy = workflow.slice(workflow.indexOf('  deploy-production:'));
  assert.equal(condition(productionDeploy, 4), normalMainCondition,
    'production deployment must remain normal-main-only and never run for either manual candidate mode');
  assert.doesNotMatch(productionDeploy, /cms_image(?!_only)|cms-image/,
    'the production receiver must continue receiving only its existing API/cron release contract');
  assert.match(productionDeploy, /printf '%s\\n%s\\n' "\$API_IMAGE" "\$CRON_IMAGE" > \.ci-images/,
    'the production release manifest must continue containing only API and cron digests');
  assert.match(deployment, /publicação e artefato de digest separados, ainda sem consumo pelo deploy automático/i);
  assert.match(deployment, /não ativa nem implanta o Payload CMS em produção/i);

  assert.equal(condition(candidateManifest, 8), candidateExpression);
  assert.match(candidateManifest, /API_IMAGE:[\s\S]*steps\.publish\.outputs\.api_image/);
  assert.match(candidateManifest, /CRON_IMAGE:[\s\S]*steps\.publish\.outputs\.cron_image/);
  assert.match(candidateManifest, /CMS_IMAGE:[\s\S]*steps\.publish_cms\.outputs\.cms_image/);
  assert.match(candidateManifest, /ownerinc-portal-api@sha256:\[0-9a-f\]\{64\}/);
  assert.match(candidateManifest, /ownerinc-portal-cron@sha256:\[0-9a-f\]\{64\}/);
  assert.match(candidateManifest, /ownerinc-portal-cms@sha256:\[0-9a-f\]\{64\}/);
  assert.match(candidateManifest, /schemaVersion: 1[\s\S]*commit: process\.env\.GITHUB_SHA[\s\S]*runId: process\.env\.GITHUB_RUN_ID[\s\S]*runAttempt: process\.env\.GITHUB_RUN_ATTEMPT[\s\S]*api: process\.env\.API_IMAGE[\s\S]*cron: process\.env\.CRON_IMAGE[\s\S]*cms: process\.env\.CMS_IMAGE/);
  const candidateUpload = containingStep(workflow, 'name: payload-release-candidate');
  assert.equal(condition(candidateUpload, 8), candidateExpression);
  assert.match(candidateUpload, /path: candidate\.json/);
  assert.match(candidateUpload, /retention-days: 30/);
  assert.equal(condition(recoveryPull, 8), candidateExpression);
  assert.match(recoveryPull, /docker pull "\$API_IMAGE"[\s\S]*docker pull "\$CRON_IMAGE"[\s\S]*docker pull "\$CMS_IMAGE"/);
  assert.equal(condition(recovery, 8), candidateExpression);
  assert.match(recovery, /sudo env[\s\S]*API_IMAGE="\$API_IMAGE"[\s\S]*node scripts\/test-payload-preauthority-recovery\.mjs/);
  assert.match(recoveryReport, /always\(\)[\s\S]*payload-preauthority-recovery-report[\s\S]*retention-days: 30/);
  assert.equal(condition(qualifiedManifest, 8), `success() && ${candidateExpression}`);
  assert.match(qualifiedManifest, /node scripts\/qualify-payload-candidate\.mjs[\s\S]*--candidate candidate\.json --report "\$RECOVERY_REPORT"[\s\S]*--output qualified-candidate\.json/);
  assert.doesNotMatch(qualifiedManifest, /node <<|JSON\.parse|const expectedChecks/u,
    'the workflow must invoke the executable, adversarially tested qualifier rather than duplicating it inline');
  const qualifiedUpload = containingStep(workflow, 'name: payload-recovery-qualified-candidate');
  assert.equal(condition(qualifiedUpload, 8), `success() && ${candidateExpression}`);
  assert.match(qualifiedUpload, /path: qualified-candidate\.json/);
  assert.match(qualifiedUpload, /if-no-files-found: error/);
  assert.match(candidateUpload, /if-no-files-found: error/);
  assert.match(workflow, /candidate_artifact_id: \$\{\{ steps\.upload_candidate\.outputs\.artifact-id \}\}/);
  assert.match(workflow, /qualified_artifact_id: \$\{\{ steps\.upload_qualified\.outputs\.artifact-id \}\}/);
  assert.match(workflow, /recovery_report_artifact_id: \$\{\{ steps\.upload_recovery_report\.outputs\.artifact-id \}\}/);

  const policy = ({ event, ref, cmsImageOnly = false, publishCandidateOnly = false }) => {
    const conflict = event === 'workflow_dispatch' && cmsImageOnly === true && publishCandidateOnly === true;
    if (conflict) return { validationFails: true, apiCron: false, cms: false, legacyArtifact: false, candidateArtifact: false, deploy: false };
    const mainRelease = (event === 'push' || event === 'workflow_dispatch') && ref === 'refs/heads/main'
      && cmsImageOnly !== true && publishCandidateOnly !== true;
    const cmsOnly = event === 'workflow_dispatch' && ref.startsWith('refs/heads/')
      && cmsImageOnly === true && publishCandidateOnly !== true;
    const candidate = event === 'workflow_dispatch' && ref.startsWith('refs/heads/')
      && publishCandidateOnly === true && cmsImageOnly !== true;
    return {
      validationFails: false,
      apiCron: mainRelease || candidate,
      cms: mainRelease || cmsOnly || candidate,
      legacyArtifact: mainRelease,
      candidateArtifact: candidate,
      deploy: mainRelease,
    };
  };
  const scenarios = [
    [{ event: 'pull_request', ref: 'refs/pull/42/merge' }, { validationFails: false, apiCron: false, cms: false, legacyArtifact: false, candidateArtifact: false, deploy: false }],
    [{ event: 'push', ref: 'refs/heads/main' }, { validationFails: false, apiCron: true, cms: true, legacyArtifact: true, candidateArtifact: false, deploy: true }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/main' }, { validationFails: false, apiCron: true, cms: true, legacyArtifact: true, candidateArtifact: false, deploy: true }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/main', cmsImageOnly: true }, { validationFails: false, apiCron: false, cms: true, legacyArtifact: false, candidateArtifact: false, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final', cmsImageOnly: true }, { validationFails: false, apiCron: false, cms: true, legacyArtifact: false, candidateArtifact: false, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final' }, { validationFails: false, apiCron: false, cms: false, legacyArtifact: false, candidateArtifact: false, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final', publishCandidateOnly: true }, { validationFails: false, apiCron: true, cms: true, legacyArtifact: false, candidateArtifact: true, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/main', publishCandidateOnly: true }, { validationFails: false, apiCron: true, cms: true, legacyArtifact: false, candidateArtifact: true, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final', cmsImageOnly: true, publishCandidateOnly: true }, { validationFails: true, apiCron: false, cms: false, legacyArtifact: false, candidateArtifact: false, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/tags/v1', cmsImageOnly: true }, { validationFails: false, apiCron: false, cms: false, legacyArtifact: false, candidateArtifact: false, deploy: false }],
  ];
  for (const [context, expected] of scenarios) {
    assert.deepEqual(policy(context), expected, `${context.event} ${context.ref} cms_image_only=${context.cmsImageOnly}`);
  }
});

test('candidate CI runs the complete native Linux root setup suite as a mandatory gate before image effects', async () => {
  const [workflow, setupTests, packager] = await Promise.all([
    read('.github/workflows/ci.yml'), read('tests/unit/payload-preauthority-ci-setup.test.mjs'),
    read('scripts/package-payload-candidate.mjs'),
  ]);
  const name = 'Test preauthority CI setup with native Linux root';
  const setup = namedStep(workflow, name);
  assert.equal(condition(setup, 8),
    "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.publish_candidate_only == true && inputs.cms_image_only != true");
  assert.match(workflow, /runs-on: ubuntu-latest/u);
  assert.ok(workflow.indexOf('node-version: 24') < workflow.indexOf(`      - name: ${name}`));
  assert.equal(setup.split('        run: |\n')[1]?.trim(),
    'set -euo pipefail\n          sudo env PATH="$PATH" HOME=/root node --test tests/unit/payload-preauthority-ci-setup.test.mjs',
    'preserve checkout cwd and setup-node PATH; execute only this suite without filtering or suppressing its exit');
  assert.doesNotMatch(setup, /continue-on-error|always\(|failure\(|\|\||\beval\b|secrets\.|\bcd\b|--test-name-pattern/u);
  assert.equal(workflow.split(`      - name: ${name}\n`).length - 1, 1);
  for (const later of ['Build CMS with synthetic build-only configuration', 'Build production images', 'Publish immutable images', 'Publish CMS immutable image',
    'Run disposable four-store preauthority recovery on published digests', 'Create recovery-qualified candidate manifest']) {
    assert.ok(workflow.indexOf(`      - name: ${name}`) < workflow.indexOf(`      - name: ${later}`), `${name} must precede ${later}`);
  }
  assert.match(setupTests, /const nativeRoot = process\.platform === 'linux' && process\.getuid\?\.\(\) === 0 && process\.getgid\?\.\(\) === 0;/u);
  assert.equal((setupTests.match(/if \(!nativeRoot\) return t\.skip\(/gu) || []).length, 3,
    'the sudo Linux invocation makes all three native branches execute and exposes a zero-skipped suite summary');
  assert.equal((setupTests.match(/t\.skip\(/gu) || []).length, 3,
    'this dedicated suite must not have another skip path hidden from the Linux/root condition');
  // A+B requires successful named gates, not an exact count of workflow steps.
  // This additional mandatory step must not replace or weaken any existing gate.
  assert.match(packager, /for \(const name of requiredSteps\)[\s\S]*job\.steps\.filter\(step => step\.name === name\)[\s\S]*steps\[0\]\.conclusion !== 'success'/u);
});

test('CI mirror covers all pinned Hub bases without changing production pins or weakening gates', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  const step = namedStep(workflow, 'Verify pinned CI mirrors and configure runner pulls');
  const service = workflow.slice(workflow.indexOf('    services:'), workflow.indexOf('    steps:'));
  assert.match(service, /image: mirror\.gcr\.io\/library\/postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777/u);
  const sources = await Promise.all(['api/Dockerfile', 'cron/Dockerfile', 'cms/Dockerfile',
    'docker-compose.yml', 'docker-compose.payload.yml', 'scripts/integration/editorial-admin-session-fixture.compose.yml',
    'scripts/integration/payload-functional-base-images.mjs'].map(read));
  const required = new Set([...sources, workflow].flatMap(source => [...source.matchAll(
    /\b(postgres|nginx|node|golang):[A-Za-z0-9_.-]+@sha256:([0-9a-f]{64})/gu,
  )].map(([, name, digest]) => `${name}:${digest}`)));
  const mirrored = new Set([...step.matchAll(/\['([a-z]+)', '([0-9a-f]{64})'\]/gu)].map(([, name, digest]) => `${name}:${digest}`));
  assert.equal(required.size, 5, 'review new Hub dependencies instead of silently relying on an unverified cache');
  assert.deepEqual(mirrored, required, 'both Node bases plus Go, Nginx and PostgreSQL must be checked, not only the first failed service');
  for (const source of sources) assert.doesNotMatch(source, /mirror\.gcr\.io|public\.ecr\.aws/u,
    'transport change must remain in CI, not production Dockerfiles/Compose/fixture contracts');
  assert.match(step, /test "\$RUNNER_ENVIRONMENT" = github-hosted/u);
  assert.match(step, /test -z "\$\{DOCKER_HOST:-\}"[\s\S]*test -z "\$\{DOCKER_CONTEXT:-\}"[\s\S]*docker context show/u);
  assert.match(step, /sudo dockerd --validate --config-file=\/etc\/docker\/daemon\.json/u);
  assert.match(step, /sudo systemctl kill --kill-whom=main --signal=HUP docker\.service/u);
  assert.match(step, /for attempt in \{1\.\.15\}; do[\s\S]*test "\$mirror_ready" = true/u);
  assert.match(step, /docker inspect --format '\{\{\.State\.Health\.Status\}\}' "\$POSTGRES_SERVICE_ID"\)" = healthy/u);
  assert.doesNotMatch(step, /(?:continue-on-error|always\(|insecure-registr|tlsverify|restart docker|docker login|secrets\.|\beval\b|\|\| true)/u);
  assert.ok(workflow.indexOf('      - name: Verify pinned CI mirrors') < workflow.indexOf('      - run: npm run verify'));
  assert.match(namedStep(workflow, 'Build production images'), /BUILDX_BUILDER: default[\s\S]*docker buildx inspect default \| grep --extended-regexp '\^Driver:\[\[:space:\]\]\+docker\$'/u);
  assert.match(step, /config\['registry-mirrors'\] = \['https:\/\/mirror\.gcr\.io'\]/u);
  assert.match(step, /config = json\.load\(source\)[\s\S]*json\.dump\(config, target\)/u,
    'preserve all unrelated hosted-runner daemon options');
});

function mirrorProbeSource(workflow) {
  const step = namedStep(workflow, 'Verify pinned CI mirrors and configure runner pulls');
  return step.split("node --input-type=module <<'NODE'\n")[1].split('\n          NODE')[0]
    .split('\n').map(line => line.slice(10)).join('\n');
}

test('CI manifest probe uses exact raw-byte hashes and fails closed (HTTP explicitly mocked, no Docker)', async () => {
  const original = mirrorProbeSource(await read('.github/workflows/ci.yml'));
  const payloads = Array.from({ length: 5 }, (_, index) => Buffer.from(`synthetic registry index ${index}`));
  let index = 0;
  const source = original.replace(/\['([a-z]+)', '([0-9a-f]{64})'\]/gu, (_match, name) =>
    `['${name}', '${createHash('sha256').update(payloads[index++]).digest('hex')}']`)
    .replace("import { createHash } from 'node:crypto';", '');
  assert.equal(index, 5);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const probe = new AsyncFunction('fetch', 'createHash', 'Buffer', 'AbortSignal', 'console', source);
  for (const mode of ['good', 'same-length-tamper', 'unavailable', 'rate-limit', 'timeout', 'redirect']) {
    let calls = 0; const messages = [];
    const fetchMock = async (url, options) => {
      assert.match(url, /^https:\/\/mirror\.gcr\.io\/v2\/library\/(postgres|nginx|node|golang)\/manifests\/sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(options.headers, { Accept: 'application/vnd.oci.image.index.v1+json' });
      assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
      let raw = payloads[calls++];
      if (mode === 'timeout' || mode === 'redirect') throw new Error('synthetic transport failure');
      if (mode === 'same-length-tamper') { raw = Buffer.from(raw); raw[0] ^= 1; }
      return new Response(raw, { status: mode === 'unavailable' ? 404 : mode === 'rate-limit' ? 429 : 200,
        headers: { 'docker-content-digest': 'sha256:' + createHash('sha256').update(payloads[calls - 1]).digest('hex') } });
    };
    const operation = probe(fetchMock, createHash, Buffer, AbortSignal, { log: message => messages.push(message) });
    if (mode === 'good') { await operation; assert.equal(calls, 5); assert.equal(messages.length, 5); }
    else { await assert.rejects(operation); assert.equal(calls, 1); assert.equal(messages.length, 0); }
  }
});

test('CI daemon merge preserves unrelated config and rejects malformed config in private offline fixtures', async t => {
  const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) { t.skip('Python unavailable; CI Python config merge execution pending'); return; }
  const step = namedStep(await read('.github/workflows/ci.yml'), 'Verify pinned CI mirrors and configure runner pulls');
  const snippet = step.split("sudo python3 - <<'PYTHON'\n")[1].split('\n          PYTHON')[0]
    .split('\n').map(line => line.slice(10)).join('\n');
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const fixture = await mkdtemp(path.join(parent, 'ci-daemon-merge-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const filename = path.join(fixture, 'daemon-fixture.json');
  // Execute only an in-memory copy with its fixed CI path replaced by this
  // private fixture. No sudo, Docker, service or production file is accessed.
  const source = snippet.replace("filename = '/etc/docker/daemon.json'", 'filename = __import__("sys").argv[1]');
  assert.notEqual(source, snippet);
  const run = () => spawnSync(python, ['-I', '-S', '-B', '-c', source, filename], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { 'registry-mirrors': ['https://mirror.gcr.io'] });
  const existing = { 'log-driver': 'json-file', features: { 'containerd-snapshotter': true },
    'registry-mirrors': ['https://previous.fixture.invalid'], builder: { gc: { enabled: true } } };
  await writeFile(filename, JSON.stringify(existing));
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { ...existing, 'registry-mirrors': ['https://mirror.gcr.io'] });
  for (const raw of ['[]', 'null', 'true', '{invalid']) {
    await writeFile(filename, raw); assert.notEqual(run().status, 0);
    assert.equal(await readFile(filename, 'utf8'), raw, 'invalid configuration must not be overwritten');
  }
});

test('CMS image pins Node and rebuilds the matching upstream esbuild source with a patched Go toolchain', async () => {
  const [dockerfile, dockerignore, packageJsonText, lockText, goMod, goSum, compose, runtimePackaging, apiPackageText, apiLockText] = await Promise.all([
    read('cms/Dockerfile'), read('cms/Dockerfile.dockerignore'), read('cms/package.json'), read('cms/package-lock.json'),
    read('cms/go-build/go.mod'), read('cms/go-build/go.sum'), read('docker-compose.payload.yml'),
    read('cms/scripts/check-runtime-packaging.mjs'), read('api/package.json'), read('api/package-lock.json'),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const lock = JSON.parse(lockText);
  const apiPackage = JSON.parse(apiPackageText);
  const apiLock = JSON.parse(apiLockText);
  const pinnedBase = /^FROM node:24-alpine3\.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS /gm;
  assert.equal((dockerfile.match(pinnedBase) || []).length, 3,
    'all independent CMS base stages must pin the current Node 24 Alpine registry index digest');
  assert.equal((dockerfile.match(/apk upgrade --no-cache/g) || []).length, 3,
    'each independent base filesystem must apply Alpine security updates');
  assert.equal((dockerfile.match(/npm install --global npm@12\.2\.0/g) || []).length, 3,
    'keep the required npm CLI while replacing the vulnerable bundled npm version');
  assert.equal((dockerfile.match(/brace-expansion@5\.0\.11/g) || []).length, 3,
    'replace npm 12.2.0 bundled brace-expansion in every independent image stage');
  assert.equal((dockerfile.match(/undici@6\.28\.1/g) || []).length, 3,
    'replace npm 12.2.0 bundled undici with its Trivy-fixed compatible release');
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional/,
    'the embedded API graph must omit optional Firebase/Firestore dependencies');
  assert.match(dockerfile, /@img\/sharp-linuxmusl-x64@0\.35\.5[\s\S]*@img\/sharp-libvips-linuxmusl-x64@1\.3\.4/,
    'restore the API lockfile-matched Sharp musl runtime packages explicitly');
  assert.match(dockerfile, /CMD \["npm", "start"\]/,
    'npm remains the production startup command');
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM golang:1\.26\.9-alpine3\.23@sha256:96123126ac58e910f4dd3619a8901e2fb6d1ad84b59b1232cac7c9ea65a8f888 AS esbuild-builder/,
    'esbuild must use the registry-pinned official Go 1.26.9 toolchain fixing the October stdlib findings');
  assert.match(goMod, /^go 1\.26\.9$/mu, 'the module floor must agree with the patched local toolchain');
  assert.match(dockerfile, /test "\$\(go version \| awk '\{print \$3\}'\)" = "go1\.26\.9"/u,
    'the build must verify the actual compiler version, not only its image tag');
  assert.match(dockerfile, /GOPROXY=https:\/\/proxy\.golang\.org GOSUMDB=sum\.golang\.org/,
    'Go dependencies must use the public proxy and checksum database');
  assert.match(dockerfile, /go build -mod=readonly -trimpath -buildvcs=false[\s\S]*github\.com\/evanw\/esbuild\/cmd\/esbuild/,
    'rebuild only the versioned upstream esbuild command with locked Go module sums');
  assert.match(dockerfile, /go version -m \/out\/esbuild[\s\S]*A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w=/,
    'the built executable must embed the verified upstream v0.28.2 module sum');
  assert.equal((dockerfile.match(/COPY --from=esbuild-builder(?: --chown=node:node)? \/out\/esbuild/g) || []).length, 2,
    'use the rebuilt binary for the Next build and final CMS runtime');
  assert.match(dockerignore, /!cms\/go-build\/go\.mod[\s\S]*!cms\/go-build\/go\.sum/,
    'the Docker context must allow only the pinned Go module manifests');
  assert.match(goMod, /require github\.com\/evanw\/esbuild v0\.28\.2/u);
  assert.match(goSum, /github\.com\/evanw\/esbuild v0\.28\.2 h1:A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w=/u);
  assert.match(goSum, /golang\.org\/x\/sys v0\.0\.0-20220715151400-c0bba94af5f8 h1:0A\+M6Uqn\+Eje4kHMK80dtF3JCXC4ykBgQG4Fe06QRhQ=/u);
  const builder = dockerfile.slice(dockerfile.indexOf('FROM --platform=$BUILDPLATFORM golang:'), dockerfile.indexOf('\n\nFROM sources'));
  assert.match(builder, /GOTOOLCHAIN=local CGO_ENABLED=0/,
    'use only the pinned toolchain and build a static Linux executable');
  assert.match(builder, /test "\$TARGETOS\/\$TARGETARCH" = "linux\/amd64"/,
    'fail closed instead of copying the x64 replacement into another target architecture');
  assert.match(builder, /GOOS="\$TARGETOS" GOARCH="\$TARGETARCH" go build -mod=readonly -trimpath -buildvcs=false/,
    'cross-build the explicit target reproducibly without ambient VCS metadata');
  assert.doesNotMatch(builder, /(?:-ldflags|(?:^|\s)-s(?:\s|$)|(?:^|\s)-w(?:\s|$))/,
    'do not strip Go build information used for toolchain and module attestation');
  assert.match(builder, /test "\$\(\/out\/esbuild --version\)" = "0\.28\.2"/,
    'the replacement executable must report the same version as the locked JavaScript package');
  assert.match(builder, /go version -m \/out\/esbuild \| grep -F 'go1\.26\.9'[\s\S]*go version -m \/out\/esbuild \| grep -F 'v0\.28\.2'[\s\S]*go version -m \/out\/esbuild \| grep -F 'h1:A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w='/,
    'attest the embedded Go toolchain, exact upstream module release, and verified module checksum');
  assert.match(runtimePackaging, /esbuild\.transformSync\('const answer: number = 42'/,
    'final image smoke exercises the rebuilt executable through the locked esbuild JavaScript API');
  assert.match(runtimePackaging, /--import', 'tsx', tsxSmokeFile/,
    'final image smoke runs a real TypeScript file through the retained TSX runtime and esbuild');
  assert.match(runtimePackaging, /node_modules\/payload\/bin\.js/,
    'the final image invokes the Payload CLI needed by migrations');
  assert.match(runtimePackaging, /payloadCli, 'info'/,
    'the Payload CLI smoke runs without connecting to a database');
  assert.match(compose, /npm run migrate/,
    'the migration service continues to invoke the Payload migration script through npm');
  assert.equal(packageJson.dependencies.tsx, '4.23.15');
  assert.equal(packageJson.overrides.tsx, '$tsx', 'all transitive tsx copies must match the direct runtime dependency');
  assert.equal(packageJson.overrides.esbuild, '0.28.2', 'all esbuild copies must use the current upstream release');
  assert.equal(apiPackage.overrides['@fastify/busboy'], '3.2.2',
    'the one actual Firebase Admin production advisory in the embedded API graph uses its fixed version');
  assert.equal(apiPackage.overrides['@grpc/grpc-js'], '1.14.5');
  assert.equal(apiPackage.overrides['brace-expansion'], '2.1.6');
  assert.equal(apiLock.packages['node_modules/@fastify/busboy'].version, '3.2.2');
  assert.equal(apiLock.packages['node_modules/@grpc/grpc-js'].version, '1.14.5');
  assert.equal(apiLock.packages['node_modules/brace-expansion'].version, '2.1.6');

  const tsxPackages = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/tsx$/.test(path));
  assert.ok(tsxPackages.length > 0, 'the package graph must retain the TSX runtime');
  for (const [path, entry] of tsxPackages) assert.equal(entry.version, '4.23.15', path);
  const esbuildPackages = Object.entries(lock.packages).filter(([path]) =>
    /(?:^|\/)node_modules\/(?:esbuild|@esbuild\/[^/]+)$/.test(path));
  assert.ok(esbuildPackages.some(([path]) => path === 'node_modules/@esbuild/linux-x64' || path.endsWith('/node_modules/@esbuild/linux-x64')),
    'the lockfile must retain the Linux x64 esbuild binary');
  assert.equal(esbuildPackages.filter(([path]) => path.startsWith('node_modules/@esbuild/')).length, 26,
    'retain all esbuild platform packages in the lockfile while unifying their versions');
  for (const [path, entry] of esbuildPackages) assert.equal(entry.version, '0.28.2', path);
});
