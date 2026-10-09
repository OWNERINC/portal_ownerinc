import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { controlCommandOptions, createFixtureCommandFailure, FixtureFailure, runFixtureCommand } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createCommandDiagnostic, initializerDiagnosticPhases, sanitizeCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';

const repo = path.resolve('.');
const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version']).status === 0);
const options = controlCommandOptions('initialize-isolated', '/synthetic/release');
const frame = (body = 'initializer_command_failed\n', phase = 'portal_grants_migrate') => `${body}PREAUTHORITY_INITIALIZER_DIAGNOSTIC phase=${phase} installStage=portal_grants_pending commandExit=17 commandSignal=none privateStderr=retained\n`;

test('initializer reason and phase require the exact action/substep, exit 2 and a complete finite frame', async () => {
  const runtime = await readFile('ops/payload-control-runtime.py', 'utf8');
  const initializer = await readFile('scripts/integration/payload-preauthority-initialize.mjs', 'utf8');
  const phases = runtime.match(/INITIALIZER_DIAGNOSTIC_PHASES = set\('''([\s\S]*?)'''\.split\(\)\)/u)[1].trim().split(/\s+/u);
  assert.deepEqual([...initializerDiagnosticPhases].sort(), phases.sort());
  for (const [, phase] of runtime.matchAll(/_initializer_phase\('([a-z_]+)'\)/gu)) assert.ok(phases.includes(phase));
  assert.match(initializer, /controlCommandContext: 'payload-control:initialize-isolated'/u);
  const parse = (stderr, extra = {}) => createCommandDiagnostic({ ...options, status: 2, stderr, ...extra });
  for (const phase of phases) {
    const diagnostic = parse(frame(undefined, phase));
    assert.equal(diagnostic.controlErrorIdentifier, 'initializer_command_failed');
    assert.equal(diagnostic.initializer.phase, phase);
    assert.deepEqual(sanitizeCommandDiagnostic(diagnostic), diagnostic);
  }
  for (const stderr of [frame('unknown_private_reason\n'), frame() + 'private-tail\n',
    'private-prefix\n' + frame(), frame(undefined, 'private_arbitrary_phase'),
    frame().replace('portal_grants_pending', 'private_stage'), frame().replace('commandExit=17', 'commandExit=999'),
    frame().replace('commandSignal=none', 'commandSignal=9'), frame().replace('commandExit=17', 'commandExit=none'),
    frame('initializer_command_signaled\n'), frame('initializer_internal_error\n'), frame().trimEnd()]) {
    assert.equal(parse(stderr).controlErrorIdentifier, null);
    assert.equal(parse(stderr).initializer, undefined);
    assert.doesNotMatch(JSON.stringify(parse(stderr)), /private-|private_|unknown_private/u);
  }
  for (const extra of [{ controlCommandContext: null }, { substep: 'payload_control_verify_release' },
    { status: 0 }, { status: null, errorCode: 'ETIMEDOUT' }, { signal: 'SIGKILL' }]) {
    assert.equal(parse(frame(), extra).controlErrorIdentifier, null);
    assert.equal(parse(frame(), extra).initializer, undefined);
  }
  assert.equal(parse('unsafe_backup_directory\n').controlErrorIdentifier, 'unsafe_backup_directory', 'older single-line adapter errors remain attributable');
  assert.equal(parse('Guard requires inherited exclusive operation lease\n').controlErrorIdentifier, 'guard_operation_lease_required');
  assert.equal(parse('initializer_command_failed\n').controlErrorIdentifier, null, 'new errors always require their runtime frame');
  for (const controlCommandContext of ['payload-control:release-preflight', 'payload-control:verify-release', 'payload-operations-guard']) {
    assert.equal(parse('initializer_command_failed\n', { controlCommandContext }).controlErrorIdentifier, null);
  }
  for (const file of ['ops/payload-control-runtime.py', 'ops/payload-control-state.py', 'ops/payload-control-inventory.py']) {
    const source = await readFile(file, 'utf8');
    // Every fixed fail() code reachable through runtime/state/inventory must
    // remain classified; internal parse codes caught and rewrapped are not
    // independently authorized as top-level failures.
    for (const [, code] of source.matchAll(/fail\('([a-z][a-z0-9_]+)'\)/gu)) {
      let stderr = `${code}\n`;
      if (code === 'initializer_command_failed') stderr = frame();
      if (code === 'initializer_command_signaled') stderr = frame(`${code}\n`).replace('commandExit=17 commandSignal=none', 'commandExit=none commandSignal=15');
      if (code === 'initializer_command_launch_failed') stderr = frame(`${code}\n`).replace('commandExit=17', 'commandExit=none').replace('privateStderr=retained', 'privateStderr=none');
      assert.equal(parse(stderr).controlErrorIdentifier, code, `${file}: fixed error ${code} must be classified`);
    }
  }
  const native = parse(frame('native_catalog_verification_failed\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_types reason=preauthority_native_type_inventory_mismatch sqlstate=none\n', 'floor_native_catalog'));
  assert.equal(native.nativeCatalogVerifier.stage, 'native_types');
  assert.equal(native.initializer.phase, 'floor_native_catalog');
  const signaled = createFixtureCommandFailure({ status: null, signal: 'SIGTERM', stderr: Buffer.from(frame()) }, options);
  assert.equal(signaled.diagnostic.commandSignal, 'SIGTERM');
  assert.equal(signaled.diagnostic.controlErrorIdentifier, null);
});

test('create-only initializer argv is accepted by the real Compose parser without contacting services', async t => {
  const version = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', timeout: 30000 });
  if (version.error || version.status !== 0) return t.skip('Docker Compose CLI unavailable; no service or daemon is required for this parser test');
  const runtime = await readFile('ops/payload-control-runtime.py', 'utf8');
  const argv = ['up', '--no-start', '--no-recreate', '--no-build', '--no-deps', '--pull', 'never'];
  assert.ok(runtime.includes(`self._initializer_compose([${argv.map(value => `'${value}'`).join(', ')}, service], creation=True)`));
  const help = spawnSync('docker', ['compose', ...argv, '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(help.status, 0, help.stderr);
  for (const flag of ['--no-start', '--no-recreate', '--no-deps', '--no-build']) assert.ok(help.stdout.includes(flag));
  assert.doesNotMatch(runtime, /\['create', '--no-build', '--no-deps'/u);
});

test('actual Python main and command wrapper preserve finite primary failure, private stderr and secondary hold independently', async t => {
  if (!python) return t.skip('Python 3 unavailable');
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const directory = await mkdtemp(path.join(parent, 'initializer-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Real Runtime command execution/main emission, but not a constructor or
  // Docker/DB proof: inject only the command entrypoint in this transport test.
  const program = String.raw`
import importlib.util,os,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('R',os.path.join(sys.argv[1],'ops','payload-control-runtime.py'))
R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
runtime=R.Runtime.__new__(R.Runtime); runtime.runtime_dir=sys.argv[2]; runtime.state={'installIntent':None}
if os.name!='nt':
    # Supply an actual inherited fd9 for command transport, not a constructor
    # or production lease proof. Only this test-created private file is opened.
    descriptor=os.open(os.path.join(runtime.runtime_dir,'synthetic-lease'),os.O_CREAT|os.O_RDWR,0o600)
    os.dup2(descriptor,9)
    if descriptor!=9: os.close(descriptor)
runtime._initializer_phase('portal_grants_migrate')
mode=sys.argv[3]
if mode=='launch': runtime.run=lambda:runtime._initializer_command([os.path.join(runtime.runtime_dir,'missing-executable')])
elif mode=='internal':
    def unexpected(): raise ValueError('private-unexpected-exception')
    runtime.run=unexpected
elif mode=='signal':
    if os.name=='nt':
        # Windows does not supply POSIX negative signal returncodes. This seam
        # exercises formatting only; Linux executes an actual signaled child.
        from types import SimpleNamespace
        def signaled():
            with patch.object(R.subprocess,'run',return_value=SimpleNamespace(returncode=-15,stdout=b'')):
                runtime._initializer_command(['synthetic-signal'])
        runtime.run=signaled
    else:
        runtime.run=lambda:runtime._initializer_command([sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGTERM)'])
else:
    runtime.run=lambda:runtime._initializer_command([sys.executable,'-c',"import sys;sys.stderr.write('private-tool-stderr-'+'x'*20000);sys.exit(17)"])
if mode=='evidence-failure':
    def refused(*_args): raise OSError('private-evidence-write-error')
    R.STATE._write_exclusive=refused
with patch.object(R,'Runtime',lambda *_args:runtime): sys.exit(R.main(['control','initialize-isolated','/synthetic/release','/synthetic/request']))
`;
  for (const [mode, reason] of [['command', 'initializer_command_failed'], ['evidence-failure', 'initializer_command_failed'], ['launch', 'initializer_command_launch_failed'],
    ['internal', 'initializer_internal_error'], ['signal', 'initializer_command_signaled']]) {
    let failure;
    const evidence = [];
    try {
      runFixtureCommand(python, ['-B', '-c', program, repo, directory, mode], { ...options, privateCommandEvidence: evidence });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof FixtureFailure);
    const secondary = new FixtureFailure('post_restore_fixture_hold_failed', createCommandDiagnostic({ substep: 'post_restore_fixture_hold', status: 2, stderr: 'private-hold-detail' }));
    const report = createRecoveryFailureReportFields({ primaryError: failure, secondaryError: secondary });
    assert.equal(report.failureCode, 'fixture_command_failed');
    assert.equal(report.failureContext.writerRestart.failureCode, 'post_restore_fixture_hold_failed');
    assert.equal(report.commandDiagnostic.controlErrorIdentifier, reason);
    assert.equal(report.commandDiagnostic.initializer.phase, 'portal_grants_migrate');
    assert.equal(report.commandDiagnostic.initializer.installStage, 'none');
    assert.equal(report.commandDiagnostic.initializer.commandExitCode, ['command', 'evidence-failure'].includes(mode) ? 17 : null);
    assert.equal(report.commandDiagnostic.initializer.commandSignal, mode === 'signal' ? 15 : null);
    assert.equal(report.commandDiagnostic.initializer.privateStderrRetained, mode === 'command');
    assert.doesNotMatch(JSON.stringify(report), /private-tool|private-unexpected|private-hold|synthetic\/|stderr|stdout/u);
    assert.equal(evidence.length, 1);
  }
  const files = await readdir(directory);
  const stderrFiles = files.filter(name => /^payload-initialize-command-[0-9a-f]{32}\.stderr$/u.test(name));
  assert.equal(stderrFiles.length, 1);
  assert.equal((await readFile(path.join(directory, stderrFiles[0]))).length, 16 * 1024);
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(directory, stderrFiles[0]))).mode & 0o777, 0o600);
  const unknownEvidence = [];
  let opaque;
  try {
    runFixtureCommand(process.execPath, ['-e', 'process.stderr.write("private-unknown-tool-output\\n");process.exit(2)'], { ...options, privateCommandEvidence: unknownEvidence });
  } catch (error) { opaque = error; }
  assert.equal(opaque.diagnostic.controlErrorIdentifier, null);
  assert.equal(opaque.diagnostic.initializer, undefined);
  assert.match(unknownEvidence[0].stderr.toString(), /private-unknown-tool-output/u);
  assert.doesNotMatch(JSON.stringify(createRecoveryFailureReportFields({ primaryError: opaque })), /private-unknown/u);
  let timeout;
  try {
    runFixtureCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(frame())});setInterval(()=>{},1000)`], { ...options, timeout: 200 });
  } catch (error) { timeout = error; }
  assert.ok(timeout instanceof FixtureFailure);
  assert.equal(timeout.diagnostic.commandError, 'command_timeout');
  assert.equal(timeout.diagnostic.commandExitCode, null);
  assert.equal(timeout.diagnostic.controlErrorIdentifier, null, 'a killed wrapper never authorizes an adapter reason');
  assert.equal(timeout.diagnostic.initializer, undefined);
});
