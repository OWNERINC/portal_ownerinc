import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../../src/migrations/20261019_135005_portal_pages.ts', import.meta.url)
const mediaLifecycleMigrationPath = new URL('../../src/migrations/20261019_150233_portal_page_media_upload_lifecycle.ts', import.meta.url)
const mediaLifecycleSnapshotPath = new URL('../../src/migrations/20261019_150233_portal_page_media_upload_lifecycle.json', import.meta.url)
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

test('media lifecycle migration is additive and constrains upload/hash/completion state', async () => {
  const [migration, index, snapshotText] = await Promise.all([
    readFile(mediaLifecycleMigrationPath, 'utf8'), readFile(indexPath, 'utf8'), readFile(mediaLifecycleSnapshotPath, 'utf8'),
  ])
  const up = migration.slice(migration.indexOf('export async function up'), migration.indexOf('export async function down'))
  const down = migration.slice(migration.indexOf('export async function down'))
  assert.match(index, /migration_20261019_150233_portal_page_media_upload_lifecycle/)
  assert.match(index, /name: '20261019_150233_portal_page_media_upload_lifecycle'/)
  assert.match(up, /ALTER TABLE "portal_page_media" ALTER COLUMN "sha256" DROP NOT NULL/u)
  assert.match(up, /ADD CONSTRAINT "portal_page_media_lifecycle_check"/u)
  assert.match(up, /"state" = 'uploading' AND "sha256" IS NULL AND "completed_at" IS NULL/u)
  assert.match(up, /"state" = 'complete' AND "sha256" IS NOT NULL AND "sha256" ~ '\^\[0-9a-f\]\{64\}\$' AND "completed_at" IS NOT NULL/u)
  assert.match(down, /DROP CONSTRAINT "portal_page_media_lifecycle_check"/u)
  assert.match(down, /ALTER TABLE "portal_page_media" ALTER COLUMN "sha256" SET NOT NULL/u)
  assert.doesNotMatch(migration, /ALTER TABLE "(?:news_articles|news_media|news_schedules|news_audit|legacy_news_revisions|news_migration_runs|news_migration_items)"/u)

  const snapshot = JSON.parse(snapshotText) as { tables?: Record<string, { columns?: Record<string, { notNull?: boolean }> }> }
  assert.equal(snapshot.tables?.['public.portal_page_media']?.columns?.sha256?.notNull, false)
  assert.equal(snapshot.tables?.['public.portal_page_media']?.columns?.state?.notNull, true)
  assert.equal(snapshot.tables?.['public.news_media']?.columns?.sha256?.notNull, true)
})
