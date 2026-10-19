import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../../src/migrations/20261019_135005_portal_pages.ts', import.meta.url)
const indexPath = new URL('../../src/migrations/index.ts', import.meta.url)
const generatedTypesPath = new URL('../../src/payload-types.ts', import.meta.url)

test('generated page migration is additive and its down path drops only page-owned schema', async () => {
  const migration = await readFile(migrationPath, 'utf8')
  const up = migration.slice(migration.indexOf('export async function up'), migration.indexOf('export async function down'))
  const down = migration.slice(migration.indexOf('export async function down'))
  assert.match(up, /CREATE TABLE "portal_page_categories"/)
  assert.match(up, /CREATE TABLE "portal_page_media"/)
  assert.match(up, /CREATE TABLE "portal_pages"/)
  assert.match(up, /CREATE TABLE "_portal_pages_v"/)
  assert.match(up, /REFERENCES "public"\."portal_page_media"/)
  assert.match(up, /REFERENCES "public"\."portal_page_categories"/)
  assert.doesNotMatch(up, /ALTER TABLE "(?:news_articles|news_media|news_schedules|news_audit|legacy_news_revisions|news_migration_runs|news_migration_items)"/)
  assert.doesNotMatch(up, /(?:news_articles|news_media|news_schedules|news_audit|legacy_news_revisions|news_migration_runs|news_migration_items|owner_news_)/)
  assert.match(down, /DROP TABLE "portal_pages"/)
  assert.match(down, /DROP TABLE "portal_page_media"/)
  assert.match(down, /DROP TABLE "portal_page_categories"/)
  assert.match(down, /DROP TABLE "_portal_pages_v"/)
  assert.doesNotMatch(down, /(?:news_articles|news_media|news_schedules|news_audit|legacy_news_revisions|news_migration_runs|news_migration_items|owner_news_)/)
})

test('Payload migration index and generated collection types include all new collections', async () => {
  const index = await readFile(indexPath, 'utf8')
  const types = await readFile(generatedTypesPath, 'utf8')
  assert.match(index, /migration_20261019_135005_portal_pages/)
  assert.match(index, /name: '20261019_135005_portal_pages'/)
  for (const slug of ['portal-pages', 'portal-page-categories', 'portal-page-media']) {
    assert.ok(types.includes(`'${slug}'`), `generated types include ${slug}`)
  }
})
