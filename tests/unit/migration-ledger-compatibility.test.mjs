import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const {
  expectedVersions,
  historicalVersions,
  historicalExpectedVersions,
  buildHistoricalExpectedVersions,
  isAcceptedMigrationLedger,
} = require('./db/verify-migrations.js');

test('accepts the current repository and historical production migration ledgers', () => {
  assert.deepEqual(historicalVersions, [
    '036_payload_editorial_control',
    '037_owner_news_cutover',
  ]);
  assert.equal(isAcceptedMigrationLedger(expectedVersions), true);
  assert.equal(isAcceptedMigrationLedger(historicalExpectedVersions), true);
});

test('inserts historical markers before 038 when future migrations follow it', () => {
  const futureVersions = Object.freeze([...expectedVersions, '039_future']);
  assert.deepEqual(buildHistoricalExpectedVersions(futureVersions), [
    ...expectedVersions.filter((version) => version !== '038_disable_legacy_editorial_writes'),
    '036_payload_editorial_control',
    '037_owner_news_cutover',
    '038_disable_legacy_editorial_writes',
    '039_future',
  ]);
});

test('rejects missing or duplicate historical insertion anchors', () => {
  const anchor = '038_disable_legacy_editorial_writes';
  for (const versions of [
    expectedVersions.filter((version) => version !== anchor),
    [...expectedVersions, anchor],
  ]) {
    assert.throws(
      () => buildHistoricalExpectedVersions(versions),
      /Expected exactly one migration anchor: 038_disable_legacy_editorial_writes/,
    );
  }
});

test('rejects unknown, missing, duplicate, and reordered migration ledger entries', () => {
  for (const versions of [expectedVersions, historicalExpectedVersions]) {
    assert.equal(isAcceptedMigrationLedger([...versions, '039_unknown']), false);
    assert.equal(isAcceptedMigrationLedger(versions.slice(1)), false);
    assert.equal(isAcceptedMigrationLedger([...versions, versions.at(-1)]), false);
    assert.equal(
      isAcceptedMigrationLedger([versions[1], versions[0], ...versions.slice(2)]),
      false,
    );
  }
  assert.equal(
    isAcceptedMigrationLedger(historicalExpectedVersions.filter((version) => version !== '037_owner_news_cutover')),
    false,
  );
  assert.equal(
    isAcceptedMigrationLedger([
      ...historicalExpectedVersions.slice(0, -3),
      '037_owner_news_cutover',
      '036_payload_editorial_control',
      '038_disable_legacy_editorial_writes',
    ]),
    false,
  );
});
