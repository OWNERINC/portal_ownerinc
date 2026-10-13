import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CI_BASE_PINS, HUB_AUTH_KEYS, checkedImageIdentity, isolatedDockerConfiguration, main, pullPinnedBases } from '../../scripts/prepare-ci-registry-pulls.mjs';
import { validateRecoveryInputs } from '../../scripts/integration/payload-preauthority-fixture.mjs';

const imageId = index => `sha256:${String(index + 1).repeat(64)}`;
const identity = (ref, id, os = 'linux', arch = 'amd64') => Buffer.from(`${JSON.stringify([ref])}|${id}|${os}|${arch}\n`);
const fixture = () => ({ auths: {
  'https://index.docker.io/v1/': { auth: 'synthetic-hub-credential-not-real' },
  'docker.io': { username: 'synthetic-runner', password: 'synthetic-password-not-real' },
  'https://registry-1.docker.io': { identitytoken: 'synthetic-hub-token-not-real' },
  'https://index.docker.io:443/v1/': { auth: 'synthetic-alias' },
  'registry.hub.docker.com': { auth: 'synthetic-legacy' },
  'ghcr.io': { auth: 'synthetic-ghcr-credential-not-real' },
  'other.registry.invalid': { auth: 'synthetic-other-credential-not-real' },
}, credHelpers: { 'docker.io': 'synthetic-hub-helper', 'ghcr.io': 'synthetic-ghcr-helper' },
currentContext: 'default', plugins: { buildx: { version: 'fixture' } } });

test('CI config strips only Hub credentials/helpers without modifying original or losing other registry data', () => {
  const original = fixture(); const saved = structuredClone(original);
  const isolated = isolatedDockerConfiguration(original);
  assert.deepEqual(original, saved);
  assert.deepEqual(Object.keys(isolated.auths), ['ghcr.io', 'other.registry.invalid']);
  assert.deepEqual(isolated.auths['ghcr.io'], original.auths['ghcr.io']);
  assert.equal(isolated.credHelpers['ghcr.io'], 'synthetic-ghcr-helper');
  for (const key of HUB_AUTH_KEYS) assert.equal(isolated.credHelpers[key], '');
  assert.deepEqual(isolated.plugins, original.plugins);
  assert.ok(Object.keys(isolatedDockerConfiguration({}).credHelpers).length > 0, 'do not trigger default helper autodetection after stripping the last auth');
  assert.equal(isolatedDockerConfiguration({ credsStore: '' }).credsStore, '');
});

test('present empty per-host overrides select Hub file-store and preserve global/other helpers (Docker CLI 28 precedence)', () => {
  const selected = isolatedDockerConfiguration({ ...fixture(), credsStore: 'synthetic-global-helper' });
  const choose = host => Object.hasOwn(selected.credHelpers, host) ? selected.credHelpers[host] : selected.credsStore;
  assert.equal(selected.credsStore, 'synthetic-global-helper');
  for (const key of HUB_AUTH_KEYS) assert.equal(choose(key), '');
  assert.equal(choose('ghcr.io'), 'synthetic-ghcr-helper');
  assert.equal(choose('unlisted.registry.invalid'), 'synthetic-global-helper');
});

test('malformed credential config or foreign contexts refuse rather than destroying other identities', () => {
  for (const input of [{ credsStore: true }, { currentContext: 'production-remote' },
    { auths: [] }, { credHelpers: [] }, [], null]) assert.throws(() => isolatedDockerConfiguration(input));
});

function engineFixture(config, mode = 'good') {
  const calls = []; const messages = [];
  const run = async (program, args) => {
    calls.push([program, args]);
    assert.equal(program, 'docker'); assert.deepEqual(args.slice(0, 2), ['--config', '/private/config']);
    assert.ok(!args.includes('tag'), 'retag is not an @digest adoption strategy');
    const ref = args.at(-1); const isMirror = ref.startsWith('mirror.gcr.io/');
    const selected = CI_BASE_PINS.find(([name, tag, digest]) => ref === `${isMirror ? 'mirror.gcr.io/library/' : ''}${name}:${tag}@sha256:${digest}`);
    assert.ok(selected, 'only exact reviewed tag+digest selection can be pulled/inspected');
    const [name, , digest] = selected; const index = CI_BASE_PINS.indexOf(selected);
    if (args[2] === 'pull') {
      assert.equal(args[3], '--platform=linux/amd64');
      // Mocked behavior only: contaminated credentials yield a mirror auth
      // error followed by Hub fallback failure. No native-engine claim here.
      if (!isMirror && config.auths?.['https://index.docker.io/v1/']) throw new Error('synthetic private upstream endpoint');
      if (mode === 'mirror-failure' && isMirror) throw new Error('synthetic mirror outage');
      if (mode === 'canonical-failure' && !isMirror) throw new Error('synthetic canonical fallback failure');
      return Buffer.from('synthetic Docker pull output');
    }
    assert.deepEqual(args.slice(2, 4), ['image', 'inspect']);
    let repo = `${isMirror ? 'mirror.gcr.io/library/' : 'docker.io/library/'}${name}@sha256:${digest}`;
    if (!isMirror && mode === 'tag-only') repo = `mirror.gcr.io/library/${name}@sha256:${digest}`;
    if (mode === 'wrong-digest') repo = repo.replace(digest, 'f'.repeat(64));
    return identity(repo, !isMirror && mode === 'different-id' ? imageId(8) : imageId(index));
  };
  return { run, calls, messages, log: value => messages.push(value) };
}

test('explicit mirror then real canonical pulls verify all five actual digest lookups (Docker mocked)', async () => {
  const f = engineFixture(isolatedDockerConfiguration(fixture()));
  await pullPinnedBases(f.run, '/private/config', f.log);
  assert.equal(f.calls.length, 20); assert.equal(f.messages.length, 5);
  for (let index = 0; index < 5; index++) {
    assert.match(f.calls[index * 4][1].at(-1), /^mirror\.gcr\.io\/library\//u);
    assert.doesNotMatch(f.calls[index * 4 + 2][1].at(-1), /^mirror/u);
    assert.deepEqual(f.calls[index * 4 + 1][1].slice(2, 4), ['image', 'inspect']);
    assert.match(f.messages[index], /^Prepared CI base: (postgres|nginx|node|golang)@sha256:[0-9a-f]{64} image=sha256:[0-9a-f]{64}$/u);
  }
});

test('contaminated-auth fallback fails while the isolated configuration reaches canonical digest verification (Docker mocked)', async () => {
  const contaminated = engineFixture(fixture());
  await assert.rejects(pullPinnedBases(contaminated.run, '/private/config', contaminated.log), /ci_canonical_digest_pull_failed/u);
  assert.equal(contaminated.messages.length, 0);
  const clean = engineFixture(isolatedDockerConfiguration(fixture()));
  await pullPinnedBases(clean.run, '/private/config', clean.log);
  assert.equal(clean.messages.length, 5);
});

for (const mode of ['mirror-failure', 'canonical-failure', 'tag-only', 'different-id', 'wrong-digest']) {
  test(`CI pre-pull cannot claim canonical resolution: ${mode} (Docker mocked)`, async () => {
    const f = engineFixture(isolatedDockerConfiguration(fixture()), mode);
    await assert.rejects(pullPinnedBases(f.run, '/private/config', f.log));
    assert.equal(f.messages.length, 0); assert.ok(f.calls.length <= 4, 'fail before next image/tests/build/publish');
  });
}

test('inspect parser rejects wrong platform, missing RepoDigest, malformed ID and garbage output', () => {
  const expected = `nginx@sha256:${'a'.repeat(64)}`;
  assert.equal(checkedImageIdentity(identity('docker.io/library/' + expected, imageId(0)), expected), imageId(0));
  for (const raw of [identity(expected, imageId(0), 'linux', 'arm64'), identity(expected, imageId(0), 'windows'),
    identity(expected, 'not-an-image-id'), Buffer.from(`null|${imageId(0)}|linux|amd64`),
    Buffer.from(`[]|${imageId(0)}|linux|amd64`), Buffer.from(`garbage|${imageId(0)}|linux|amd64`), Buffer.from('{}')]) {
    assert.throws(() => checkedImageIdentity(raw, expected));
  }
});

test('isolated config allows subsequent GHCR login without restoring Hub auth (synthetic credentials only)', () => {
  const original = fixture(); const selected = isolatedDockerConfiguration(original);
  selected.auths['ghcr.io'] = { auth: 'synthetic-new-login-not-real' };
  assert.equal(original.auths['ghcr.io'].auth, 'synthetic-ghcr-credential-not-real');
  assert.deepEqual(Object.keys(selected.auths), ['ghcr.io', 'other.registry.invalid']);
});

test('CI workflow keeps private config for hosted transport but not root recovery', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('      - name: Prepare isolated CI registry auth and pull pinned bases');
  assert.ok(start > workflow.indexOf('      - name: Verify pinned CI mirrors'));
  assert.ok(start < workflow.indexOf('      - run: npm run bootstrap'));
  const end = workflow.indexOf('\n      - ', start + 1); const step = workflow.slice(start, end);
  assert.match(step, /timeout-minutes: 15[\s\S]*run: node scripts\/prepare-ci-registry-pulls\.mjs/u);
  assert.doesNotMatch(step, /continue-on-error|always\(|\|\|/u);
  const recovery = workflowStep(workflow, 'Run disposable four-store preauthority recovery on published digests');
  assert.match(recovery, /sudo env -i \\\n\s+PATH="\$PATH" HOME=\/root/u);
  assert.doesNotMatch(recovery, /DOCKER_\w+=|sudo -E|--preserve-env/u);
  const source = await readFile(new URL('../../scripts/prepare-ci-registry-pulls.mjs', import.meta.url), 'utf8');
  assert.match(source, /await pullPinnedBases\(runDocker, directory\);[\s\S]*await appendFile\(process\.env\.GITHUB_ENV, `DOCKER_CONFIG=/u);
  assert.doesNotMatch(source, /unlink|rm\(|console\.log\(config|docker.*tag|auths.*= \{\}/u);
  const mirrorStep = workflow.slice(workflow.indexOf('      - name: Verify pinned CI mirrors'), start);
  const probes = new Set([...mirrorStep.matchAll(/\['([a-z]+)', '([0-9a-f]{64})'\]/gu)].map(([, name, digest]) => `${name}:${digest}`));
  assert.deepEqual(new Set(CI_BASE_PINS.map(([name, , digest]) => `${name}:${digest}`)), probes);
});

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function recoveryInputsFromEnvironment(environment) {
  // Same mapping used by runRecovery, with the approved execution identity
  // represented explicitly instead of requiring root or launching its services.
  return {
    platform: 'linux', uid: 0,
    images: { api: environment.API_IMAGE, cron: environment.CRON_IMAGE, cms: environment.CMS_IMAGE },
    commit: environment.GITHUB_SHA, runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT,
    dockerEnvironment: Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith('DOCKER_'))),
  };
}

test('actual workflow root environment maps to the real recovery validator; reinserting DOCKER_CONFIG rejects (no sudo/Docker)', async t => {
  const bash = [process.env.BASH, 'bash', 'C:/Program Files/Git/bin/bash.exe'].filter(Boolean)
    .find(command => spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 }).status === 0);
  if (!bash) { t.skip('Bash unavailable; actual workflow environment execution pending'); return; }
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = workflowStep(workflow, 'Run disposable four-store preauthority recovery on published digests');
  const body = step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
  assert.equal((body.match(/sudo env -i/gu) || []).length, 1);
  assert.equal((body.match(/node scripts\/test-payload-preauthority-recovery\.mjs/gu) || []).length, 1);
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const probe = 'process.stdout.write(JSON.stringify(process.env))';
  // Execute the real assignments/expansion and env -i boundary, not a hand-made
  // environment allowlist. Only privilege elevation and the operational runner
  // are replaced. This does not assert native root or Docker acceptance.
  const source = body.replace('sudo env -i', 'env -i').replace('node scripts/test-payload-preauthority-recovery.mjs',
    `${shellQuote(process.execPath.replaceAll('\\', '/'))} -e ${shellQuote(probe)}`);
  const parent = { ...process.env,
    API_IMAGE: `ghcr.io/ownerinc/ownerinc-portal-api@sha256:${'a'.repeat(64)}`,
    CRON_IMAGE: `ghcr.io/ownerinc/ownerinc-portal-cron@sha256:${'b'.repeat(64)}`,
    CMS_IMAGE: `ghcr.io/ownerinc/ownerinc-portal-cms@sha256:${'c'.repeat(64)}`,
    GITHUB_SHA: 'd'.repeat(40), GITHUB_RUN_ID: '37994301180', GITHUB_RUN_ATTEMPT: '2',
    RUNNER_TEMP: '/synthetic/runner-temp', RECOVERY_REPORT: '/synthetic/recovery-report.json',
    DOCKER_CONFIG: '/synthetic/private-docker', DOCKER_HOST: 'tcp://synthetic.invalid:2375',
    DOCKER_CONTEXT: 'synthetic-remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/synthetic/certs',
    DOCKER_CUSTOM_OVERRIDE: 'synthetic', CI_PRIVATE_SENTINEL: 'must-not-enter-recovery',
  };
  const observe = script => {
    const result = spawnSync(bash, ['-c', script], { env: parent, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const environment = observe(source);
  // Git Bash converts POSIX paths for native Windows Node. Test exact paths on
  // Linux and their preserved leaf identities on Windows; this is never native
  // root acceptance. Docker-variable absence and validator rejection are exact.
  const assertPath = (actual, expected) => {
    if (process.platform === 'win32') assert.equal(path.win32.basename(actual), path.posix.basename(expected));
    else assert.equal(actual, expected);
  };
  assertPath(environment.HOME, '/root');
  assertPath(environment.RUNNER_TEMP, parent.RUNNER_TEMP);
  assertPath(environment.PAYLOAD_RECOVERY_REPORT, parent.RECOVERY_REPORT);
  assert.equal(environment.CI_PRIVATE_SENTINEL, undefined);
  const inputs = recoveryInputsFromEnvironment(environment);
  assert.deepEqual(inputs.dockerEnvironment, {});
  assert.equal(validateRecoveryInputs(inputs), true);
  const contaminated = observe(source.replace('HOME=/root', 'HOME=/root DOCKER_CONFIG="$DOCKER_CONFIG"'));
  assertPath(contaminated.DOCKER_CONFIG, parent.DOCKER_CONFIG);
  assert.throws(() => validateRecoveryInputs(recoveryInputsFromEnvironment(contaminated)), /docker_endpoint_override_forbidden/u);
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CUSTOM_OVERRIDE']) {
    assert.throws(() => validateRecoveryInputs({ ...inputs, dockerEnvironment: { [name]: parent[name] } }),
      /docker_endpoint_override_forbidden/u);
  }
});

test('CI pre-pull gates exact recovery runtime images in the clean root local daemon, not retagged mirror names', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const prePull = workflowStep(workflow, 'Pull exact published candidate image digests for root-owned fixture');
  const recovery = workflowStep(workflow, 'Run disposable four-store preauthority recovery on published digests');
  assert.ok(workflow.indexOf(prePull) < workflow.indexOf(recovery));
  assert.equal(prePull.split('\n').find(line => line.trimStart().startsWith('if:')),
    recovery.split('\n').find(line => line.trimStart().startsWith('if:')), 'same candidate gate; pre-pull cannot be skipped independently');
  for (const variable of ['API_IMAGE', 'CRON_IMAGE', 'CMS_IMAGE']) assert.ok(prePull.includes(`docker pull "$${variable}"`));
  assert.match(prePull, /test "\$\(sudo env -i PATH="\$PATH" HOME=\/root docker context inspect --format '\{\{json \.Endpoints\.docker\.Host\}\}'\)" = '"unix:\/\/\/var\/run\/docker\.sock"'/u);
  const inspect = prePull.slice(prePull.indexOf('sudo env -i PATH="$PATH" HOME=/root docker image inspect'));
  assert.match(inspect, /"\$API_IMAGE" "\$CRON_IMAGE" "\$CMS_IMAGE"/u);
  const cachedBases = new Set([...inspect.matchAll(/\b(postgres|nginx):[^\s]+@sha256:([0-9a-f]{64})/gu)]
    .map(([, name, digest]) => `${name}:${digest}`));
  assert.deepEqual(cachedBases, new Set(CI_BASE_PINS.filter(([name]) => ['postgres', 'nginx'].includes(name))
    .map(([name, , digest]) => `${name}:${digest}`)));
  assert.doesNotMatch(prePull, /continue-on-error|always\(|\|\| true|docker tag|--preserve-env|DOCKER_\w+=/u);
  const composeSources = await Promise.all(['docker-compose.yml', 'docker-compose.payload.yml',
    'scripts/integration/payload-preauthority-fixture.compose.yml', 'ops/compose.payload.production.yaml']
    .map(filename => readFile(path.resolve(filename), 'utf8')));
  const declaredImages = new Set(composeSources.flatMap(source => [...source.matchAll(/^\s+image:\s*(.+)$/gmu)].map(([, value]) => value)));
  const expectedImages = new Set(['${API_IMAGE:-local/ownerinc-portal-api:latest}', '${CRON_IMAGE:-local/ownerinc-portal-cron:latest}',
    '${CMS_IMAGE:-local/ownerinc-portal-cms:latest}', ...CI_BASE_PINS.filter(([name]) => ['postgres', 'nginx'].includes(name))
      .map(([name, tag, digest]) => `${name}:${tag}@sha256:${digest}`)]);
  assert.deepEqual(declaredImages, expectedImages, 'review a new runtime image before relying on the five-image root cache boundary');
});

test('CLI has no fixture mode and refuses non-hosted/extra-argument invocation without Docker', async () => {
  await assert.rejects(main(['--fixture']), /hosted_ci_registry_context_required/u);
  const result = spawnSync(process.execPath, ['scripts/prepare-ci-registry-pulls.mjs', '--fixture', 'synthetic-private-sentinel'],
    { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /synthetic-private-sentinel|username|password|token\?|auth.docker/u);
});
