import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatPreparationFailure, projectPreparationFailure } from '../helpers/payload-preparation-attribution.mjs';

const preparationSource = readFileSync(new URL('./payload-preparation-authentication.test.mjs', import.meta.url), 'utf8');
const helperSource = readFileSync(new URL('../helpers/payload-preparation-attribution.mjs', import.meta.url), 'utf8');
const recoverySource = readFileSync(new URL('./payload-production-recovery.test.mjs', import.meta.url), 'utf8');
const names = [...preparationSource.matchAll(/^test\('([^'\r\n]+)'/gmu)].map(match => match[1]);
const declaredInventory = [...helperSource.matchAll(/^  \['(preparation\.[a-z0-9-]+)', '([^'\r\n]+)'\],$/gmu)]
  .map(match => ({ id: match[1], name: match[2] }));
const marker = 'Native qualification supervision failed; private diagnostics withheld.\n';
const canary = 'PRIVATE_CANARY secret-path AssertionError pid=123456 Bearer secret SELECT private FROM secrets';

// Fixtures use the actual declarations, independently of the projector's table.
// Numbers in these tests are 1-based TAP result numbers, not inferred failures.
function tapFixture({ failed = [], skipped = [], todo = [], passingTodo = [], diagnostic = '' } = {}) {
  const lines = ['TAP version 13'];
  for (const [index, name] of names.entries()) {
    const number = index + 1;
    const outcome = failed.includes(number) || todo.includes(number) ? 'not ok' : 'ok';
    const directive = skipped.includes(number) ? ` # SKIP ${canary}`
      : todo.includes(number) || passingTodo.includes(number) ? ` # TODO ${canary}` : '';
    lines.push(`# Subtest: ${name}`, `${outcome} ${number} - ${name}${directive}`,
      '  ---', '  duration_ms: 0.125', "  type: 'test'");
    if (diagnostic) lines.push(...diagnostic.split('\n'));
    lines.push('  ...');
  }
  lines.push('1..31', '# tests 31', '# suites 0',
    `# pass ${31 - failed.length - skipped.length - todo.length - passingTodo.length}`,
    `# fail ${failed.length}`, '# cancelled 0', `# skipped ${skipped.length}`,
    `# todo ${todo.length + passingTodo.length}`, '# duration_ms 1.25');
  return lines.join('\n') + '\n';
}

function result(stdout = tapFixture({ failed: [16] }), extra = {}) {
  return { status: 1, signal: null, stdout, stderr: '', ...extra };
}

function opaque(value, expectedTap) {
  const projection = projectPreparationFailure(value);
  if (expectedTap) assert.equal(projection.tap, expectedTap);
  assert.equal(projection.attribution, 'unknown');
  assert.equal(projection.authenticated, false);
  assert.equal(projection.counts, null);
  assert.deepEqual(projection.failedIds, []);
  assert.deepEqual(projection.skippedIds, []);
  assert.deepEqual(projection.todoIds, []);
  return projection;
}

function privateSafe(projection) {
  const text = formatPreparationFailure(projection);
  assert.ok(Buffer.byteLength(text) <= 4096);
  assert.doesNotMatch(text, /PRIVATE_CANARY|secret-path|AssertionError|123456|Bearer|SELECT|Traceback|\/root\//u);
  for (const name of names) assert.equal(text.includes(name), false);
  return text;
}

test('literal attribution inventory matches every ordered real preparation declaration', () => {
  assert.equal((preparationSource.match(/^test\(/gmu) ?? []).length, 31);
  assert.equal(names.length, 31);
  assert.deepEqual(declaredInventory.map(entry => entry.name), names);
  assert.equal(new Set(declaredInventory.map(entry => entry.id)).size, 31);
  assert.equal(declaredInventory[15].id, 'preparation.inherited-group');
  // Exercise every mapping, not just its length or the currently suspected case.
  for (const [index, entry] of declaredInventory.entries()) {
    const projection = projectPreparationFailure(result(tapFixture({ failed: [index + 1] })));
    assert.equal(projection.tap, 'complete');
    assert.deepEqual(projection.failedIds, [entry.id]);
  }
});

test('complete failure, multiple failures and all-pass project only bounded fixed fields', () => {
  const single = projectPreparationFailure(result());
  assert.deepEqual(single, {
    kind: 'preparation-failure-attribution-v1', process: 'exit-nonzero', tap: 'complete',
    supervisor: 'absent', attribution: 'observed-tap', authenticated: false,
    counts: { tests: 31, suites: 0, pass: 30, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
    failedIds: ['preparation.inherited-group'], skippedIds: [], todoIds: [],
  });
  const multiple = projectPreparationFailure(result(tapFixture({ failed: [2, 10, 16, 17] })));
  assert.deepEqual(multiple.failedIds, ['preparation.native-b0-cli', 'preparation.native-context',
    'preparation.inherited-group', 'preparation.child-group']);
  const all = projectPreparationFailure(result(tapFixture({ failed: names.map((_, index) => index + 1) })));
  assert.equal(all.counts.fail, 31);
  privateSafe(all);
  const passed = projectPreparationFailure(result(tapFixture(), { status: 0 }));
  assert.equal(passed.process, 'exit-zero');
  assert.equal(passed.counts.pass, 31);
  assert.deepEqual(passed.failedIds, []);
});

test('supported skip and both todo outcomes are diagnostic states with consistent counts', () => {
  const projection = projectPreparationFailure(result(tapFixture({ skipped: [2], todo: [10], passingTodo: [11] }), { status: 0 }));
  assert.equal(projection.tap, 'complete');
  assert.deepEqual(projection.counts, { tests: 31, suites: 0, pass: 28, fail: 0, cancelled: 0, skipped: 1, todo: 2 });
  assert.deepEqual(projection.skippedIds, ['preparation.native-b0-cli']);
  assert.deepEqual(projection.todoIds, ['preparation.native-context', 'preparation.generated-audit']);
  assert.deepEqual(projection.failedIds, []);
  privateSafe(projection);
});

test('private YAML, comments and nested records cannot supply identities', () => {
  const diagnostic = [
    `  error: '${canary}'`, '  stack: |-', '    /root/secret-path:123456',
    `    not ok 2 - ${names[1]}`, '    1..31', '    # fail 31',
    `  # Subtest: ${names[9]}`, `  not ok 10 - ${names[9]}`,
  ].join('\n');
  const stdout = tapFixture({ failed: [16], diagnostic }).replace('TAP version 13\n',
    `TAP version 13\n# ${canary}\n# not ok 2 - ${names[1]}\n    not ok 10 - ${names[9]}\n    1..31\n`);
  const projection = projectPreparationFailure(result(stdout));
  assert.deepEqual(projection.failedIds, ['preparation.inherited-group']);
  privateSafe(projection);
  // Indentation cannot hide a missing required top-level result.
  opaque(result(stdout.replace(`not ok 16 - ${names[15]}\n`, `    not ok 16 - ${names[15]}\n`)));
});

test('extra, duplicate, unknown, reordered and unsupported top-level material fails closed', () => {
  const valid = tapFixture({ failed: [16] });
  const first = `ok 1 - ${names[0]}\n`;
  const second = `ok 2 - ${names[1]}\n`;
  for (const stdout of [
    valid.replace(first, first + first),
    valid.replace(first, `ok 1 - ${canary}\n`),
    valid.replace(first, `ok 2 - ${names[0]}\n`),
    valid.replace(second, `ok 2 - ${names[0]}\n`),
    valid.replace(first, `ok 01 - ${names[0]}\n`),
    valid.replace(first, `ok 1 - ${names[0]} # UNSUPPORTED ${canary}\n`),
    valid.replace(first, `not ok 1 - ${names[0]} # SKIP\n`),
    valid.replace('1..31\n', first + '1..31\n'),
    valid + `not ok 32 - ${canary}\n`,
    valid.replace('TAP version 13\n', `TAP version 13\n${canary}\n`),
    valid.replace('TAP version 13', 'TAP version 14'),
    valid.replace('TAP version 13\n', 'TAP version 13\nBail out!\n'),
    valid.replace(first, first + '  ...\n'),
    valid.replace('TAP version 13\n', 'TAP version 13\n    ---\n'),
    valid.replace('TAP version 13\n', 'TAP version 13\n    ...\n'),
    valid.replace('  ---\n', '  ---\n  ---\n'),
  ]) opaque(result('', { stdout }), 'invalid');
});

test('plans, terminal counters and diagnostic closure must be complete and consistent', () => {
  const valid = tapFixture({ failed: [16] });
  for (const stdout of [
    valid.replace('1..31\n', '1..30\n'),
    valid.replace('1..31\n', '1..31\n1..31\n'),
    valid.replace('TAP version 13\n', 'TAP version 13\n1..31\n'),
    valid.replace('# tests 31\n', '# tests 31\n# tests 31\n'),
    valid.replace('# tests 31', '# tests 32'),
    valid.replace('# suites 0', '# suites 1'),
    valid.replace('# pass 30', '# pass 31'),
    valid.replace('# fail 1', '# fail 0'),
    valid.replace('# cancelled 0', '# cancelled 1'),
    valid.replace('# skipped 0', '# skipped 1'),
    valid.replace('# todo 0', '# todo 1'),
    valid.replace('# pass 30', '# pass 030'),
    valid.replace('# fail 1', '# fail 1 extra'),
    valid.replace('# fail 1', '# fail 9999999999999999999999'),
    valid.replace('# duration_ms 1.25', '# duration_ms Infinity'),
    valid.replace('# tests 31\n# suites 0', '# suites 0\n# tests 31'),
    valid.replace('# todo 0\n', ''),
    valid.replace('  ...\n', ''),
    valid.replace('  duration_ms: 0.125\n', `not ok 16 - ${names[15]}\n`),
  ]) opaque(result(stdout), 'invalid');
  for (const stdout of ['', 'TAP version 13\n', valid.slice(0, -1),
    valid.slice(0, valid.indexOf('1..31')), valid.slice(0, valid.indexOf('# skipped 0')),
    valid.slice(0, valid.indexOf('  ...')),
    valid.replace('# duration_ms 1.25\n', '')]) opaque(result(stdout), 'incomplete');
});

test('input bytes, line counts and individual lines are capped before attribution', () => {
  const valid = tapFixture({ failed: [16] });
  for (const stdout of [
    '#'.repeat(2 * 1024 * 1024 + 1),
    '\u00e9'.repeat(1024 * 1024 + 1),
    valid.replace('TAP version 13\n', 'TAP version 13\n' + '#\n'.repeat(32768)),
    valid.replace('TAP version 13\n', 'TAP version 13\n#' + 'x'.repeat(16 * 1024) + '\n'),
    valid.replace('TAP version 13\n', 'TAP version 13\n#' + '\u00e9'.repeat(8192) + '\n'),
    valid.replaceAll('\n', '\r\n'),
    valid.replace(names[0] + '\n  ---', names[0] + '\u2028\n  ---'),
    valid.replace(names[0] + '\n  ---', names[0] + '\u2029\n  ---'),
    undefined, null, 1, Buffer.from(valid),
  ]) opaque(result('', { stdout }), 'invalid');
  for (const stderr of ['x'.repeat(4097), '\u00e9'.repeat(2049), null, undefined, Buffer.from(marker)]) {
    const projection = opaque(result(valid, { stderr }));
    assert.equal(projection.supervisor, 'unknown');
    privateSafe(projection);
  }
});

test('generic supervisor stderr is recognized only as one exact whole line', () => {
  const reported = opaque(result('', { stderr: marker }), 'incomplete');
  assert.equal(reported.process, 'exit-nonzero');
  assert.equal(reported.supervisor, 'reported');
  assert.equal(formatPreparationFailure(reported).includes('phase'), false);
  for (const stderr of [marker.trimEnd(), marker + '\n', marker.replace('\n', '\r\n'),
    canary + marker, marker + canary, ' ' + marker]) {
    const projection = opaque(result('', { stderr }));
    assert.equal(projection.supervisor, 'unknown');
    privateSafe(projection);
  }
  // Even complete TAP must not attribute IDs across a conflicting wrapper marker.
  for (const status of [0, 1]) {
    const projection = opaque(result(tapFixture({ failed: status ? [16] : [] }), { status, stderr: marker }));
    assert.equal(projection.tap, 'complete');
    assert.equal(projection.supervisor, 'reported');
  }
});

test('process outcomes remain separate and conflicting or missing fields never attribute IDs', () => {
  assert.equal(opaque(result('', { status: null, signal: 'SIGKILL' })).process, 'signal');
  for (const signal of [null, 'SIGTERM']) {
    assert.equal(opaque(result('', { status: null, signal, error: new Error(canary) })).process, 'spawn-error');
  }
  for (const extra of [
    { status: null }, { status: undefined }, { status: '1' }, { status: NaN }, { status: 1.5 },
    { status: -1 }, { status: 256 }, { signal: undefined }, { signal: 'private' },
    { signal: 'SIGKILL' }, { error: new Error(canary) },
  ]) assert.equal(opaque(result(undefined, extra)).process, 'unknown');
  opaque(result(tapFixture(), { status: 1 }));
  opaque(result(tapFixture({ failed: [16] }), { status: 0 }));
  opaque(result(tapFixture({ failed: [16] }), { status: null, signal: 'SIGKILL' }));
  for (const key of ['status', 'signal', 'stdout', 'stderr']) {
    const missing = result(); delete missing[key];
    assert.equal(opaque(missing).process, 'unknown');
  }
});

test('own data properties reject hostile getters, inherited fields, proxies and coercion', () => {
  let calls = 0;
  const hostile = () => { calls += 1; throw new Error(canary); };
  const proxy = new Proxy({}, { get: hostile, getOwnPropertyDescriptor: hostile, getPrototypeOf: hostile, ownKeys: hostile });
  const revocable = Proxy.revocable({}, {}); revocable.revoke();
  for (const input of [null, undefined, 1, canary, proxy, revocable.proxy, () => {}, Object.create(result())]) {
    const projection = projectPreparationFailure(input);
    assert.equal(projection.attribution, 'unknown');
    privateSafe(projection);
  }
  assert.deepEqual(projectPreparationFailure(Object.assign(Object.create(null), result())).failedIds, ['preparation.inherited-group']);
  for (const key of ['status', 'signal', 'stdout', 'stderr', 'error']) {
    const accessor = result(); Object.defineProperty(accessor, key, { get: hostile });
    opaque(accessor);
    const coercible = { toString: hostile, valueOf: hostile, toJSON: hostile, [Symbol.toPrimitive]: hostile };
    opaque(result(undefined, { [key]: coercible }));
    opaque(result(undefined, { [key]: proxy }));
  }
  const error = new Error(canary);
  for (const key of ['code', 'message', 'stack', 'toJSON']) Object.defineProperty(error, key, { get: hostile });
  assert.equal(opaque(result('', { status: null, error })).process, 'spawn-error');
  const unused = result(); Object.defineProperty(unused, 'pid', { get: hostile });
  assert.deepEqual(projectPreparationFailure(unused).failedIds, ['preparation.inherited-group']);
  assert.equal(calls, 0);
});

test('formatter binds immutable projector snapshots and never serializes caller objects', () => {
  const projection = projectPreparationFailure(result());
  const original = privateSafe(projection);
  for (const value of [projection, projection.counts, projection.failedIds, projection.skippedIds, projection.todoIds]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { projection.process = canary; }, TypeError);
  assert.throws(() => projection.failedIds.push(canary), TypeError);
  let calls = 0;
  const hostile = () => { calls += 1; throw new Error(canary); };
  const proxy = new Proxy(projection, { get: hostile, getOwnPropertyDescriptor: hostile });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const input of [{ ...projection }, Object.create(projection), { toJSON: hostile }, proxy, revoked.proxy, null, 1, canary]) {
    assert.equal(formatPreparationFailure(input), 'preparation-attribution: unavailable');
  }
  assert.equal(formatPreparationFailure(projection), original);
  assert.equal(calls, 0);
});

test('a forged complete conforming inventory is explicitly unauthenticated text observation', () => {
  const projection = projectPreparationFailure(result(tapFixture({ failed: [2, 16] })));
  assert.equal(projection.attribution, 'observed-tap');
  assert.equal(projection.authenticated, false);
  assert.deepEqual(projection.failedIds, ['preparation.native-b0-cli', 'preparation.inherited-group']);
  // No text parser can authenticate this synthetic stream's origin.
  assert.equal(Object.hasOwn(projection, 'qualified'), false);
  privateSafe(projection);
});

test('real offline Node TAP supports private diagnostics and the complete literal inventory', () => {
  const code = `import test from 'node:test';
const names = ${JSON.stringify(names)};
for (const [index, name] of names.entries()) {
  test(name, { skip: index === 1, todo: index === 9 || index === 10 }, t => {
    t.diagnostic(${JSON.stringify(canary)});
    if (index === 15 || index === 9) throw new Error(${JSON.stringify(canary)});
  });
}`;
  // Synthetic callbacks only: no preparation/native code is imported or run.
  // Empty env also prevents nested-runner context or opt-in flags from escaping.
  const child = spawnSync(process.execPath, ['--input-type=module', '--test-reporter=tap', '--eval', code],
    { encoding: 'utf8', env: {}, timeout: 15000, maxBuffer: 512 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  const projection = projectPreparationFailure(child);
  assert.equal(projection.tap, 'complete');
  assert.deepEqual(projection.failedIds, ['preparation.inherited-group']);
  assert.deepEqual(projection.skippedIds, ['preparation.native-b0-cli']);
  assert.deepEqual(projection.todoIds, ['preparation.native-context', 'preparation.generated-audit']);
  assert.deepEqual(projection.counts, { tests: 31, suites: 0, pass: 27, fail: 1, cancelled: 0, skipped: 1, todo: 2 });
  privateSafe(projection);
});

const originalAssertions = [
  "  assert.equal(preparation.error?.code, undefined, 'native preparation supervisor timed out');",
  "  assert.equal(preparation.status, 0, 'native preparation process checks failed (private diagnostics withheld)');",
  "  assert.match(preparation.stdout, /# skipped 0\\b/u, 'native preparation must not skip');",
  '  assert.match(preparation.stdout, /# fail 0\\b/u);',
].join('\n');
const wiringStart = recoverySource.indexOf('  const preparation = nativeRun(');
const wiringEnd = recoverySource.indexOf("  writeFileSync(path.join(reportDirectory, 'preparation-processes.json')", wiringStart);

function exerciseWiring(preparation, { project = projectPreparationFailure, format = formatPreparationFailure, diagnostic } = {}) {
  const diagnostics = [];
  let invocations = 0, failure;
  const nativeRun = (...args) => {
    invocations += 1;
    assert.deepEqual(args, [process.execPath, ['--test', '--test-reporter=tap',
      'tests/unit/payload-preparation-authentication.test.mjs'], 420, 60, { PAYLOAD_REQUIRE_NATIVE_PREPARATION: '1' }]);
    return preparation;
  };
  const run = new Function('nativeRun', 't', 'assert', 'projectPreparationFailure', 'formatPreparationFailure',
    recoverySource.slice(wiringStart, wiringEnd));
  try { run(nativeRun, { diagnostic: diagnostic ?? (message => diagnostics.push(message)) }, assert, project, format); }
  catch (error) { failure = error; }
  assert.equal(invocations, 1);
  return { diagnostics, failure };
}

test('actual recovery wiring preserves all four original assertions and exact failure predicates', () => {
  assert.ok(wiringStart >= 0 && wiringEnd > wiringStart);
  const section = recoverySource.slice(wiringStart, wiringEnd);
  assert.ok(section.includes(originalAssertions));
  assert.equal(section.match(/assert\./gu)?.length, 4);
  assert.match(recoverySource, /test\('native ADMIN, PostgreSQL, historical application and forced-witness qualification', \{ skip: !required \}, t => \{/u);
  assert.ok(section.includes('if (preparation.error?.code !== undefined || preparation.status !== 0\n' +
    '    || !/# skipped 0\\b/u.test(preparation.stdout) || !/# fail 0\\b/u.test(preparation.stdout)) {'));
  assert.match(recoverySource, /import \{ formatPreparationFailure, projectPreparationFailure \} from '\.\.\/helpers\/payload-preparation-attribution\.mjs';/u);
  for (const stdout of [tapFixture(), '# skipped 0 diagnostic\n# fail 0 diagnostic\n']) {
    const observed = exerciseWiring(result(stdout, { status: 0 }), {
      project: () => { throw new Error('projector must remain silent'); },
      diagnostic: () => { throw new Error('diagnostic must remain silent'); },
    });
    assert.equal(observed.failure, undefined);
    assert.deepEqual(observed.diagnostics, []);
  }
});

test('actual failure wiring emits only fixed metadata while original assertions still fail', () => {
  const failed = exerciseWiring(result());
  assert.equal(failed.failure?.code, 'ERR_ASSERTION');
  assert.match(failed.failure.message, /native preparation process checks failed \(private diagnostics withheld\)/u);
  assert.equal(failed.diagnostics.length, 1);
  assert.equal(failed.diagnostics[0], formatPreparationFailure(projectPreparationFailure(result())));
  const skipped = exerciseWiring(result(tapFixture({ skipped: [2] }), { status: 0 }));
  assert.match(skipped.failure.message, /native preparation must not skip/u);
  assert.match(skipped.diagnostics[0], /preparation\.native-b0-cli/u);
  const contradictory = exerciseWiring(result(undefined, { status: 0 }));
  assert.equal(contradictory.failure?.operator, 'match');
  assert.match(contradictory.diagnostics[0], /"attribution":"unknown"/u);
  const error = new Error(canary); error.code = 'ETIMEDOUT';
  const spawn = exerciseWiring(result('', { status: null, error }));
  assert.match(spawn.failure.message, /native preparation supervisor timed out/u);
  assert.match(spawn.diagnostics[0], /"process":"spawn-error"/u);
  for (const entry of [failed, skipped, contradictory, spawn]) {
    for (const text of entry.diagnostics) assert.doesNotMatch(text, /PRIVATE_CANARY|secret-path|AssertionError|123456|ETIMEDOUT/u);
  }
});

test('projector, formatter and diagnostic exceptions cannot mask the original assertion failure', () => {
  const hostile = () => { throw new Error(canary); };
  for (const options of [{ project: hostile }, { format: hostile }, { diagnostic: hostile }]) {
    const observed = exerciseWiring(result(), options);
    assert.equal(observed.failure?.code, 'ERR_ASSERTION');
    assert.match(observed.failure.message, /native preparation process checks failed \(private diagnostics withheld\)/u);
    if (!options.diagnostic) assert.deepEqual(observed.diagnostics, ['preparation-attribution: unavailable']);
  }
});
