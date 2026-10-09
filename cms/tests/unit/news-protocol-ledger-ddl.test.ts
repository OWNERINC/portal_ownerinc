import assert from 'node:assert/strict'
import test from 'node:test'
import { NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_LEDGER_STATEMENTS } from '../../src/publication/mutation-ledger'
import { legacyLedgerDDL } from '../fixtures/protocol-ledger-legacy'

test('explicit ledger statements qualify application targets without changing legacy definitions/defaults', () => {
  assert.deepEqual(NEWS_MUTATION_LEDGER_STATEMENTS.map(statement => statement.operation),
    ['ledger-head-create', 'ledger-head-init', 'ledger-events-create'])
  assert.equal(Object.isFrozen(NEWS_MUTATION_LEDGER_STATEMENTS), true)
  assert.equal(NEWS_MUTATION_LEDGER_STATEMENTS.every(Object.isFrozen), true)
  assert.equal(NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_LEDGER_STATEMENTS.map(statement => statement.sql).join(''))
  const qualifiedLegacy = legacyLedgerDDL
    .replace('CREATE TABLE owner_news_mutation_head', 'CREATE TABLE public.owner_news_mutation_head')
    .replace('REFERENCES news_migration_runs', 'REFERENCES public.news_migration_runs')
    .replace('INSERT INTO owner_news_mutation_head', 'INSERT INTO public.owner_news_mutation_head')
    .replace('CREATE TABLE owner_news_mutation_events', 'CREATE TABLE public.owner_news_mutation_events')
  // Only inter-statement whitespace changes; every definition is independently
  // pinned in the legacy fixture, including literal/regex contents.
  assert.equal(NEWS_MUTATION_LEDGER_DDL.replace(/;\n\n/gu, ';\n'), qualifiedLegacy.replace(/;\n\n/gu, ';\n'))
  assert.match(NEWS_MUTATION_LEDGER_DDL, /coverage_version integer NOT NULL DEFAULT 0/u)
  assert.doesNotMatch(NEWS_MUTATION_LEDGER_DDL, /allow_system_table_mods|SET ROLE|GRANT|ALTER FUNCTION|CREATE.*FUNCTION/u)
})
