import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runFixtureCommand } from '../../scripts/integration/payload-preauthority-command.mjs';

// Execute the ACTUAL producer files with Node's real POSIX path implementation.
// Windows only needs this test-local path ABI view; no production file, guard,
// inventory policy, filesystem metadata or database engine is rewritten/doubled.
async function produce() {
  const dependencies = new Map();
  const link = async specifier => {
    if (!specifier.startsWith('node:')) throw new Error('producer_fixture_requires_reviewed_node_import');
    if (!dependencies.has(specifier)) {
      const native = await import(specifier);
      const values = specifier === 'node:path' ? { default: path.posix } : native;
      const names = Object.keys(values);
      dependencies.set(specifier, new vm.SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, values[name]);
      }));
    }
    return dependencies.get(specifier);
  };
  const load = async file => {
    const code = await readFile(file, 'utf8');
    const module = new vm.SourceTextModule(code, { identifier: pathToFileURL(path.resolve(file)).href });
    await module.link(link); await module.evaluate();
    return module.namespace;
  };
  const fixture = await load('scripts/integration/payload-preauthority-fixture.mjs');
  const transport = await load('scripts/integration/payload-preauthority-snapshot-runtime.mjs');
  const run = { commit: '5538227c912c9d074f25aef329d44f7457160e5a', runId: '37970701268', runAttempt: '1' };
  const names = fixture.createFixtureProjectNames(run);
  const project = names.source;
  const inventory = fixture.createInventory({ project, root: '/private/disposable/source' });
  const runtime = { project, directory: inventory.document.paths.runtime, inventory,
    payloadRelease: transport.recoveryPayloadRelease(inventory.document.paths.releases, run.commit),
    baseUrl: 'http://127.0.0.1:1' };
  const wire = transport.conversionProbeCommandInput(runtime, { commit: run.commit, python: 'python3' });
  const environment = { ...transport.recoveryFixtureEnvironment(project, runtime,
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'), ...wire.env };
  // Exactly the environment export performed by createLeasedCommandInvocation.
  // Native FD9 identity is tested separately on Linux, not emulated here.
  environment.PORTAL_OPERATION_LOCK_HELD = environment.PORTAL_OPERATION_LOCK;
  const restartObserve = transport.writerRestartCommandInput(runtime, { commit: run.commit, python: 'python3', mode: 'observe' });
  const restartResume = transport.writerRestartCommandInput(runtime, { commit: run.commit, python: 'python3', mode: 'restart',
    identities: { api: 'a'.repeat(64), cron: 'b'.repeat(64), cms: 'c'.repeat(64) } });
  const restartFixtures = [['source', names.source], ['target', names.target], ['lease-target', names.source.replace(/-source$/u, '-lease')]].map(([role, project]) => {
    const inventory = fixture.createInventory({ project, root: `/private/disposable/${role}` });
    const runtime = { project, directory: inventory.document.paths.runtime, inventory,
      payloadRelease: transport.recoveryPayloadRelease(inventory.document.paths.releases, run.commit), baseUrl: 'http://127.0.0.1:1' };
    const wire = transport.writerRestartCommandInput(runtime, { commit: run.commit, python: 'python3', mode: 'observe' });
    const environment = { ...transport.recoveryFixtureEnvironment(project, runtime,
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'), ...wire.env };
    environment.PORTAL_OPERATION_LOCK_HELD = environment.PORTAL_OPERATION_LOCK;
    return { role, wire, environment };
  });
  return { wire, environment, restartObserve, restartResume, restartFixtures, commit: run.commit, project, payloadRelease: runtime.payloadRelease };
}

export function producedLinuxRecoveryFixture() {
  return JSON.parse(runFixtureCommand(process.execPath,
    ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { env: { ...process.env, NODE_NO_WARNINGS: '1' } }).toString('utf8'));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await produce()));
}
