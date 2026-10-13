import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import { createFixtureCommandFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { dataStatementsSQL, fingerprintLogicalSnapshot, logicalSnapshotScript,
  LOGICAL_SNAPSHOT_MAX_BYTES, LOGICAL_SNAPSHOT_MAX_ROWS, schemaSnapshotQueries,
} from '../../scripts/integration/payload-logical-snapshot.mjs';

const encode = records => records.map(record => JSON.stringify(record)).join('\n');
const records = () => [
  ...Object.keys(schemaSnapshotQueries).map(section => ({ kind: 'schema', section, items:
    section === 'relations' ? [{ schema: 'public', name: 'sessions', kind: 'r' }, { schema: 'public', name: 'counter', kind: 'S' }]
      : section === 'sequences' ? [{ schema: 'public', name: 'counter', seqstart: '1', seqincrement: '3', seqcache: '2', seqmin: '1', seqmax: '9223372036854775807', seqcycle: false }]
        : section === 'constraints' ? [{ schema: 'public', relation: 'sessions', name: 'c', kind: 'c', definition: 'CHECK (true)' }] : [],
  })),
  { kind: 'table', schema: 'public', name: 'sessions', count: '3' },
  { kind: 'row', schema: 'public', name: 'sessions', text: '{"n": 9007199254740993, "value": null}' },
  { kind: 'row', schema: 'public', name: 'sessions', text: '{"n": 9007199254740993, "value": null}' },
  { kind: 'row', schema: 'public', name: 'sessions', text: '{"n": 9007199254740992, "value": ""}' },
  { kind: 'sequence', schema: 'public', name: 'counter', last_value: '9007199254740993', is_called: false },
  { kind: 'complete', version: 1 },
];
const snapshot = input => fingerprintLogicalSnapshot(encode(input), value => value);

test('independent table multiset includes duplicate rows, exact PG numeric text and operational tables', () => {
  const original = records();
  const hash = snapshot(original);
  const shuffled = structuredClone(original);
  const indices = shuffled.flatMap((row, index) => row.kind === 'row' ? [index] : []);
  [shuffled[indices[0]], shuffled[indices[2]]] = [shuffled[indices[2]], shuffled[indices[0]]];
  assert.deepEqual(snapshot(shuffled), hash);
  for (const changed of ['9007199254740994', 'null', '""']) {
    const modified = structuredClone(original);
    modified[indices[0]].text = `{ "n": ${changed} }`;
    assert.notEqual(snapshot(modified).data, hash.data);
  }
  const deleted = structuredClone(original);
  deleted.splice(indices[0], 1); deleted.find(row => row.kind === 'table').count = '2';
  assert.notEqual(snapshot(deleted).data, hash.data, 'duplicates are counted, not a set');
  assert.equal(snapshot(deleted).schema, hash.schema);
});

test('sequence state and every parameter are bound without nextval, including int64 precision', () => {
  const original = records(); const hash = snapshot(original);
  for (const key of ['seqstart','seqincrement','seqcache','seqmin','seqmax','seqcycle']) {
    const changed = structuredClone(original);
    changed.find(row => row.section === 'sequences').items[0][key] = key === 'seqcycle' ? true : '9007199254740994';
    assert.notEqual(snapshot(changed).schema, hash.schema, key);
    assert.notEqual(snapshot(changed).data, hash.data, key);
  }
  for (const [key, value] of [['last_value','9007199254740994'], ['is_called',true]]) {
    const changed = structuredClone(original); changed.find(row => row.kind === 'sequence')[key] = value;
    assert.notEqual(snapshot(changed).data, hash.data);
  }
  assert.doesNotMatch(dataStatementsSQL, /nextval\s*\(/iu);
  assert.match(dataStatementsSQL, /FROM ONLY %I\.%I/u);
  assert.match(dataStatementsSQL, /jsonb_object_agg\(k,v\)::text/u);
  assert.match(dataStatementsSQL, /t\.%I::text/u);
  assert.match(logicalSnapshotScript, /REPEATABLE READ READ ONLY/u);
  assert.equal(logicalSnapshotScript.split('\n').filter(line => line === '\\gexec').length, 1);
});

test('transport fails closed on missing sections, unsupported objects, missing data, count mismatch and limits', () => {
  const original = records();
  assert.throws(() => snapshot(original.slice(0,-1)), /logical_snapshot_incomplete/u);
  assert.throws(() => snapshot(original.filter(row => row.section !== 'routines')), /logical_snapshot_incomplete_schema/u);
  assert.throws(() => snapshot(original.filter(row => row.kind !== 'sequence')), /logical_snapshot_incomplete_data_inventory/u);
  const noRows = original.filter(row => row.kind !== 'row');
  assert.throws(() => snapshot(noRows), /logical_snapshot_row_count_mismatch/u);
  const unsupported = records(); unsupported.find(row => row.section === 'unsupported').items.push({ kind: 'foreign_server', schema: '', name: 'private-name' });
  assert.throws(() => snapshot(unsupported), { message: 'logical_snapshot_unsupported_object' });
  const unsafe = records(); unsafe.find(row => row.section === 'columns').items.push({ ordinal: 9007199254740992 });
  assert.throws(() => snapshot(unsafe), /logical_snapshot_unsafe_number/u);
  assert.throws(() => fingerprintLogicalSnapshot(Buffer.alloc(LOGICAL_SNAPSHOT_MAX_BYTES + 1), value => value), /logical_snapshot_limit_exceeded/u);
  const excessive = records().filter(row => row.kind !== 'row');
  const headerIndex = excessive.findIndex(row => row.kind === 'table');
  excessive[headerIndex].count = String(LOGICAL_SNAPSHOT_MAX_ROWS + 1);
  const tooMany = [...excessive.slice(0, headerIndex + 1),
    ...Array.from({ length: LOGICAL_SNAPSHOT_MAX_ROWS + 1 }, () => ({ kind: 'row', schema: 'public', name: 'sessions', text: '{}' })),
    ...excessive.slice(headerIndex + 1)];
  assert.throws(() => snapshot(tooMany), /logical_snapshot_limit_exceeded/u);
});

test('only finite CLI-context errors and output overflow appear in the public report', () => {
  const options = { logicalSnapshotCommandContext: 'logical-snapshot-cli', substep: 'snapshot_cms_logical_database',
    failureCode: 'logical_snapshot_fingerprint_failed', preservePrivateErrorEvidence: true, privateCommandEvidence: [] };
  const error = createFixtureCommandFailure({ status: 2, stderr: Buffer.from('logical_snapshot_unsupported_object\n') }, options);
  const report = createRecoveryFailureReportFields({ primaryError: error });
  assert.equal(report.commandDiagnostic.logicalSnapshotErrorIdentifier, 'logical_snapshot_unsupported_object');
  assert.equal(options.privateCommandEvidence.length, 1);
  for (const stderr of ['logical_snapshot_private_name\n', 'logical_snapshot_unsupported_object\nprivate-raw-schema',
    'prefix logical_snapshot_unsupported_object\n']) {
    assert.equal(createCommandDiagnostic({ ...options, status: 2, stderr }).logicalSnapshotErrorIdentifier, undefined);
  }
  assert.equal(createCommandDiagnostic({ status: 2, stderr: 'logical_snapshot_unsupported_object\n' }).logicalSnapshotErrorIdentifier, undefined);
  assert.equal(createCommandDiagnostic({ errorCode: 'ENOBUFS' }).commandError, 'output_limit_exceeded');
});

test('unknown observed CHECK syntax stays raw and changed syntax changes its hash', () => {
  const source = records();
  const constraint = source.find(row => row.section === 'constraints').items[0];
  constraint.definition = 'CHECK (unknown_operator_syntax)';
  const parser = () => { throw Error('unsupported'); };
  const before = fingerprintLogicalSnapshot(encode(source), parser);
  constraint.definition = 'CHECK (changed_unknown_operator_syntax)';
  assert.notEqual(fingerprintLogicalSnapshot(encode(source), parser).schema, before.schema);
});

test('CLI uses pure observed CHECK grouping semantics while retaining casts and quoted identifiers', () => {
  const loader = pathToFileURL(path.resolve('cms/node_modules/tsx/dist/loader.mjs')).href;
  const run = definition => {
    const fixture = records(); fixture.find(row => row.section === 'constraints').items[0].definition = definition;
    const result = spawnSync(process.execPath, ['--import', loader, 'scripts/integration/payload-logical-snapshot-cli.mjs'], {
      input: encode(fixture), encoding: 'utf8', timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.code || result.signal);
    assert.doesNotMatch(result.stdout, /sessions|9007199254740993/u);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run('CHECK (((a > 1 AND a < 9) AND b))'), run('CHECK ((a > 1 AND a < 9 AND b))'));
  assert.notEqual(run('CHECK ("true")').schema, run('CHECK (true)').schema);
  assert.notEqual(run("CHECK (a::text = '1'::text)").schema, run("CHECK (a = '1'::text)").schema);
  assert.notEqual(run('CHECK (a > 1)').schema, run('CHECK (a > 2)').schema);
});

test('recovery acceptance uses logical snapshots, dumps only in the private evidence branch', async () => {
  const source = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const body = source.slice(source.indexOf('function snapshot('), source.indexOf('async function assertQuiescentSnapshotStable'));
  assert.match(body, /portalDatabase = portal\.data; const portalSchema = portal\.schema/u);
  assert.match(body, /cmsDatabase = cms\.data; const cmsSchema = cms\.schema/u);
  assert.doesNotMatch(body, /createHash/u);
  assert.ok(body.indexOf('if (evidenceLabel)') < body.indexOf('databaseDump('));
  assert.ok(body.indexOf('if (evidenceLabel)') < body.indexOf('databaseSchemaDump('));
  assert.match(source, /maxBuffer: LOGICAL_SNAPSHOT_MAX_BYTES/u);
});

test('unchanged storage tree contract binds paths, types, modes, sizes and bytes including staging', t => {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python','python3'] : ['python3','python'];
  const python = candidates.find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) return t.skip('Python 3 unavailable; storage checker requires Python 3');
  const code = String.raw`
import importlib.util, io, json, sys, tarfile
spec=importlib.util.spec_from_file_location('snapshot_runtime',sys.argv[1])
runtime=importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
def fingerprint(entries, mtime=1):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w') as archive:
        for name,body,mode in entries:
            member=tarfile.TarInfo(name); member.mode=mode; member.mtime=mtime
            if body is None:
                member.type=tarfile.DIRTYPE; archive.addfile(member)
            else:
                payload=body.encode(); member.size=len(payload); archive.addfile(member,io.BytesIO(payload))
    out.seek(0)
    return runtime._tar_tree(out,compressed=False)
original=[('.',None,0o700),('.owner-news-import',None,0o700),('.owner-news-import/staging',None,0o700),('.owner-news-import/staging/receipt.json','private-bytes',0o600),('media.bin','content',0o640)]
baseline=fingerprint(original)
assert fingerprint(list(reversed(original)),mtime=999)==baseline
for replacement in [('renamed.bin','content',0o640),('media.bin','changed',0o640),('media.bin','content',0o600),('media.bin',None,0o640)]:
    assert fingerprint(original[:-1]+[replacement])!=baseline
assert fingerprint(original[:-2]+original[-1:])!=baseline
assert fingerprint(original+[('extra-file','new',0o600)])!=baseline
print('storage_tree_mutations_rejected')
`;
  const result = spawnSync(python, ['-c', code, path.resolve('ops/payload-control-runtime.py')], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'storage_tree_mutations_rejected');
});
