import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const {
  expectedVersions,
  historicalVersions,
  historicalExpectedVersions,
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

test('rejects unknown, missing, duplicate, and reordered migration ledger entries', () => {
  assert.equal(isAcceptedMigrationLedger([...historicalExpectedVersions, '039_unknown']), false);
  assert.equal(
    isAcceptedMigrationLedger(historicalExpectedVersions.filter((version) => version !== '037_owner_news_cutover')),
    false,
  );
  assert.equal(
    isAcceptedMigrationLedger([
      ...historicalExpectedVersions.slice(0, -1),
      '038_disable_legacy_editorial_writes',
      '037_owner_news_cutover',
    ]),
    false,
  );
  assert.equal(
    isAcceptedMigrationLedger([
      ...historicalExpectedVersions.slice(0, 35),
      '036_payload_editorial_control',
      '037_owner_news_cutover',
      '038_disable_legacy_editorial_writes',
    ]),
    false,
  );
});
