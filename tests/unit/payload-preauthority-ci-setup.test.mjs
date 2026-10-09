import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, chown, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import * as setup from '../../scripts/integration/payload-preauthority-initialize.mjs';
import { assertSingleTestPassed, runNestedTest } from '../helpers/payload-nested-test.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeRoot = process.platform === 'linux' && process.getuid?.() === 0 && process.getgid?.() === 0;

test('CI private namespace is fixed and root-only metadata contracts do not authorize runner ancestors', () => {
  assert.equal(setup.PRIVATE_RECOVERY_BASE, '/var/lib/ownerinc-payload-recovery-ci');
  const directory = (uid, gid, mode) => ({ uid, gid, mode, isDirectory: () => true, isSymbolicLink: () => false });
  assert.doesNotThrow(() => setup.assertProtectedRecoveryDirectory(directory(0, 0, 0o755), false));
  assert.doesNotThrow(() => setup.assertProtectedRecoveryDirectory(directory(0, 0, 0o700), true));
  for (const value of [directory(1001, 0, 0o700), directory(0, 1001, 0o700), directory(0, 0, 0o770),
    directory(0, 0, 0o1777), { ...directory(0, 0, 0o700), isSymbolicLink: () => true }]) {
    assert.throws(() => setup.assertProtectedRecoveryDirectory(value, false), /unsafe_recovery_private_ancestry/u);
  }
  assert.throws(() => setup.assertProtectedRecoveryDirectory(directory(0, 0, 0o755), true), /unsafe_recovery_private_ancestry/u);
});

test('setup moves only private fixtures and scopes every Git command without global config or wildcard trust', async () => {
  const initializer = await readFile(path.join(repo, 'scripts/integration/payload-preauthority-initialize.mjs'), 'utf8');
  const runner = await readFile(path.join(repo, 'scripts/test-payload-preauthority-recovery.mjs'), 'utf8');
  const workflow = await readFile(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  assert.match(runner, /fixtureRoot = await createPrivateRecoveryRoot\(runIdentity\)/u);
  assert.doesNotMatch(runner, /mkdtemp\(path\.join\(runTemp/u);
  assert.match(runner, /PAYLOAD_RECOVERY_REPORT \|\| path\.join\(process\.env\.RUNNER_TEMP/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/payload-preauthority-recovery-report\.json/u);
  assert.match(initializer, /safe\.directory=\$\{checkout\}/u);
  assert.doesNotMatch(initializer, /safe\.directory=\*|--global|--system|SUDO_UID/u);
  assert.match(initializer, /verifyInitializerCheckout\(\{ runIdentity, run \}\)/u);
  assert.match(initializer, /actualCommit !== runIdentity\.commit/u);
  const setupStart = runner.indexOf('async function createRuntime(');
  const setupEnd = runner.indexOf('\nasync function assertAdapterRejectsNonRootOwner', setupStart);
  const runtimeSetup = runner.slice(setupStart, setupEnd);
  assert.ok(runtimeSetup.indexOf('await validateRecoveryPrivateAncestry(path.dirname(root), true)') < runtimeSetup.indexOf('await mkdir(root,'));
  assert.ok(runtimeSetup.indexOf('await validateRecoveryPrivateAncestry(root, true)') < runtimeSetup.indexOf('await writeProtectedInventory('));
  assert.ok(runner.indexOf('await verifyInitializerCheckout({ runIdentity, run });', runner.indexOf('async function runRecovery')) <
    runner.indexOf('fixtureRoot = await createPrivateRecoveryRoot(runIdentity)'));
  const failed = runner.slice(runner.indexOf('} catch (error) {', runner.indexOf('let report;')));
  assert.doesNotMatch(failed, /await rm\(fixtureRoot/u);
  const allocator = initializer.slice(initializer.indexOf('export async function createPrivateRecoveryRoot'), initializer.indexOf('function assertCheckoutMetadata'));
  assert.doesNotMatch(allocator, /recursive: true|\bchown\(|\bchmod\(/u);
  assert.match(allocator, /flag: 'wx'/u);
});

test('native Linux root loader rejects a root leaf below a real uid1001 ancestor and accepts a legitimate protected path', async t => {
  if (!nativeRoot) return t.skip('requires native Linux root/chown; metadata contracts run locally, not native PASS');
  // Reuse the stage fixture under actual root so its B0 chmod/chown assertions
  // run in the existing native CI gate, without skipping the non-root core test.
  assert.ok(['python3', 'python'].some(command => spawnSync(command, ['--version']).status === 0));
  const name = 'retry adapter uses only the stage-reviewed grant range and revalidates B0/lease/targets without effects';
  const result = runNestedTest('tests/unit/payload-install-transition.test.mjs', name, { cwd: repo });
  assertSingleTestPassed(result, name);
  const root = await mkdtemp('/var/lib/payload-ci-ancestry-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const legitimate = path.join(root, 'legitimate'); await mkdir(legitimate, { mode: 0o700 });
  await setup.validateRecoveryPrivateAncestry(legitimate, true);
  const runnerOwned = path.join(root, 'runner-owned'); await mkdir(runnerOwned, { mode: 0o700 });
  await chown(runnerOwned, 1001, 1001);
  const leaf = path.join(runnerOwned, 'root-leaf'); await mkdir(leaf, { mode: 0o700 });
  await assert.rejects(setup.validateRecoveryPrivateAncestry(leaf, true), /unsafe_recovery_private_ancestry/u);
  for (const directory of [legitimate, leaf]) {
    await writeFile(path.join(directory, 'fixture.env'), 'SYNTHETIC=private-fixture\n', { flag: 'wx', mode: 0o600 });
  }
  const python = ['python3', 'python'].find(command => spawnSync(command, ['--version']).status === 0);
  assert.ok(python, 'native inventory contract requires Python');
  const proof = spawnSync(python, ['-B', '-c', String.raw`
import importlib.util,sys
spec=importlib.util.spec_from_file_location('I',sys.argv[1]); I=importlib.util.module_from_spec(spec); spec.loader.exec_module(I)
I._verify_ancestry(sys.argv[2] + '/future-private-file', {0}, 'unsafe_inventory_ancestry')
I.verify_environment_file(sys.argv[2] + '/fixture.env', {'uid':0,'gid':0})
I._safe_regular(sys.argv[2] + '/fixture.env',mode=0o600,owner_root=True)
try: I._verify_ancestry(sys.argv[3] + '/future-private-file', {0}, 'unsafe_inventory_ancestry')
except I.InventoryError as error: assert str(error)=='unsafe_inventory_ancestry'
else: raise AssertionError('uid1001 ancestor must be rejected by actual kernel inventory policy')
try: I.verify_environment_file(sys.argv[3] + '/fixture.env', {'uid':0,'gid':0})
except I.InventoryError as error: assert str(error)=='unsafe_environment_ancestry'
else: raise AssertionError('root-owned environment below runner ancestor must not be accepted')
`, path.join(repo, 'ops/payload-control-inventory.py'), legitimate, leaf], { encoding: 'utf8', timeout: 30000 });
  assert.equal(proof.status, 0, proof.stderr);
  assert.equal((await lstat(runnerOwned)).uid, 1001);
});

test('native CI private-root allocator creates exclusive namespaces and never reuses a prior failed run', async t => {
  if (!nativeRoot) return t.skip('requires native Linux root fixed namespace; no private allocator executed on Windows');
  const identity = { runId: '731', runAttempt: '1' };
  const first = await setup.createPrivateRecoveryRoot(identity);
  const second = await setup.createPrivateRecoveryRoot(identity);
  t.after(() => Promise.all([first, second].map(directory => rm(directory, { recursive: true, force: true }))));
  assert.notEqual(first, second);
  for (const directory of [first, second]) {
    assert.equal(path.dirname(directory), setup.PRIVATE_RECOVERY_BASE);
    await setup.validateRecoveryPrivateAncestry(directory, true);
    await writeFile(path.join(directory, 'failed-run-evidence'), 'preserve synthetic failure evidence', { mode: 0o600, flag: 'wx' });
  }
  assert.equal(await readFile(path.join(first, 'failed-run-evidence'), 'utf8'), 'preserve synthetic failure evidence');
  const foreign = path.join(setup.PRIVATE_RECOVERY_BASE, `foreign-test-${path.basename(first)}`);
  await mkdir(foreign, { mode: 0o700 });
  t.after(() => rm(foreign, { recursive: true, force: true })); // Only the synthetic collision created by this test.
  await assert.rejects(setup.createPrivateRecoveryRoot(identity), /unsafe_recovery_private_namespace/u);
  assert.equal((await lstat(foreign)).isDirectory(), true, 'allocator must not remove a foreign collision');
});

test('native root verifies HEAD of an actual runner-owned checkout using only scoped Git trust and rejects checkout drift', async t => {
  if (!nativeRoot) return t.skip('requires native Linux root and real dubious-ownership Git regression; no command spy is native proof');
  const root = await mkdtemp('/var/lib/payload-ci-checkout-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const checkout = path.join(root, 'checkout'); await mkdir(checkout, { mode: 0o755 });
  const modulePath = path.join(checkout, 'scripts/integration/payload-preauthority-initialize.mjs');
  await mkdir(path.dirname(modulePath), { recursive: true, mode: 0o755 });
  for (const name of ['payload-preauthority-initialize.mjs', 'payload-preauthority-fixture.mjs']) {
    await cp(path.join(repo, 'scripts/integration', name), path.join(path.dirname(modulePath), name));
  }
  const env = { PATH: process.env.PATH, HOME: '/root', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => spawnSync('git', args, { cwd: checkout, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(git(['init']).status, 0);
  const commit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic checkout identity']);
  assert.equal(commit.status, 0, commit.stderr);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const owner = spawnSync('chown', ['-R', '1001:1001', checkout], { encoding: 'utf8' });
  assert.equal(owner.status, 0, owner.stderr); // Only this test-created checkout, never runnerhome.
  const denied = git(['rev-parse', 'HEAD']);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /dubious ownership/iu);
  const invoke = expected => spawnSync(process.execPath, ['--input-type=module', '-e', `
import {spawnSync} from 'node:child_process';
const setup=await import(${JSON.stringify(pathToFileURL(modulePath).href)});
const run=(command,args,options)=>{const result=spawnSync(command,args,{...options,env:${JSON.stringify(env)},encoding:'utf8'});if(result.status!==0)throw Error('git_failed');return Buffer.from(result.stdout);};
await setup.verifyInitializerCheckout({runIdentity:{commit:${JSON.stringify(expected)}},run});
`], { cwd: checkout, env: { ...env, GITHUB_WORKSPACE: checkout }, encoding: 'utf8', timeout: 30000 });
  const verified = invoke(head);
  assert.equal(verified.status, 0, verified.stderr);
  assert.notEqual(git(['rev-parse', 'HEAD']).status, 0, 'scoped verification must not persist Git trust');
  assert.match(invoke('0'.repeat(40)).stderr, /initializer_checkout_mismatch/u);
  await chmod(checkout, 0o777);
  assert.match(invoke(head).stderr, /unsafe_initializer_checkout/u);
  await chmod(checkout, 0o755);
  const configPath = path.join(checkout, '.git/config');
  const config = await readFile(configPath);
  await writeFile(configPath, Buffer.concat([config, Buffer.from('\n[core]\n\tbare = true\n')]));
  assert.match(invoke(head).stderr, /unsafe_initializer_checkout/u);
  await writeFile(configPath, config);
  const originalGit = path.join(checkout, '.git'); const hidden = path.join(checkout, 'hidden-git');
  await rename(originalGit, hidden);
  await symlink(hidden, originalGit, 'dir');
  assert.match(invoke(head).stderr, /unsafe_initializer_checkout/u);
});
