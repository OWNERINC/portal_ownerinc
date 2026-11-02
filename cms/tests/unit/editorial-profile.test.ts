import assert from 'node:assert/strict'
import test from 'node:test'
import { editorialConfig } from '../helpers/editorial-config'
import { assertEditorialProfile, editorialProfileDescriptor, editorialProfileHash, readEditorialProfile } from '../../src/config/editorial-profile'
import { normalizeDraftIntent } from '../../src/publication/draft-intent'
import { revisionToken, readRestoreTarget } from '../../src/publication/restore-draft'
import { randomUUID } from 'node:crypto'

test('exact profile parsing, independent sanitized factories and actual-config evidence', async () => {
  assert.equal(readEditorialProfile(undefined), 'held-v1')
  for (const bad of ['', null, ' editorial-v1', 'editorial-v2', true]) assert.throws(() => readEditorialProfile(bad))
  const held = await editorialConfig(), active = await editorialConfig('editorial-v1')
  assert.equal(assertEditorialProfile(held).id, 'held-v1')
  const evidence = assertEditorialProfile(active)
  assert.equal(evidence.sha256, editorialProfileHash(editorialProfileDescriptor('editorial-v1')))
  assert.notEqual(evidence.sha256, assertEditorialProfile(held).sha256)
  const article = active.collections.find(c => c.slug === 'news-articles')!
  assert.ok(article.versions && article.versions.drafts)
  article.versions.drafts.autosave = false
  assert.throws(() => assertEditorialProfile(active), /cms_editorial_profile_incompatible/)
  assert.equal(assertEditorialProfile(held).id, 'held-v1', 'sanitization/mutation never leaks across factories')
  article.versions.drafts.autosave = { interval: 1500 }
  article.access.readVersions = () => true
  assert.throws(() => assertEditorialProfile(active), /cms_editorial_profile_incompatible/)
})

test('draft intent overrides supplied published status before native draft selection', () => {
  for (const intent of [{ draft: true }, { autosave: true }, {}]) {
    const args = { ...intent, data: Object.keys(intent).length ? { _status: 'published' } : { title: 'Partial' } }
    assert.equal(normalizeDraftIntent(args, 'editorial-v1').draft, true)
    assert.equal(args.data._status, 'draft')
  }
  for (const _status of ['published', 'draft']) {
    const args = normalizeDraftIntent({ data: { _status } }, 'editorial-v1')
    assert.equal(args.draft, undefined, 'explicit publish/withdraw remains explicit')
  }
  assert.throws(() => normalizeDraftIntent({ autosave: true }, 'held-v1'), /news_autosave_unavailable/)
  for (const args of [{ draft: 'true' }, { publishAllLocales: true }, { publishSpecificLocale: 'pt' },
    { draft: true, unpublishAllLocales: true }, { data: { _status: 'scheduled' } }, { data: { _status: ['published'] } }]) {
    assert.throws(() => normalizeDraftIntent(args as never, 'editorial-v1'), /news_draft_intent_invalid/)
  }
})

test('actual profile evidence rejects removed, reordered or substituted safety hooks and restore endpoints', async () => {
  for (const profile of ['held-v1', 'editorial-v1'] as const) {
    const config = await editorialConfig(profile)
    const article = config.collections.find(c => c.slug === 'news-articles')!, home = config.globals.find(g => g.slug === 'news-home')!
    for (const entity of [article, home]) {
      for (const name of ['beforeOperation', 'beforeChange', 'afterChange'] as const) {
        const original = entity.hooks[name]
        for (const changed of [original.slice(1), [...original].reverse(), original.map(() => () => undefined)]) {
          if (changed.every((hook, index) => hook === original[index]) && changed.length === original.length) continue
          entity.hooks[name] = changed as never
          assert.throws(() => assertEditorialProfile(config), /cms_editorial_profile_incompatible/, `${profile}/${entity.slug}/${name}`)
        }
        entity.hooks[name] = original as never
      }
      const access = entity.access.update
      entity.access.update = () => true
      assert.throws(() => assertEditorialProfile(config), /cms_editorial_profile_incompatible/)
      entity.access.update = access
    }
    const endpoint = config.endpoints.find(e => e.path === '/news-restore-draft' && e.method === 'post')!
    const handler = endpoint.handler
    endpoint.handler = () => Response.json({})
    assert.throws(() => assertEditorialProfile(config), /cms_editorial_profile_incompatible/)
    endpoint.handler = handler
    assert.equal(assertEditorialProfile(config).id, profile)
  }
})

test('source tokens detect coalesced bytes and status, ignore latest bookkeeping, bind parent', () => {
  const documentId = randomUUID(), revision = { id: randomUUID(), updatedAt: new Date().toISOString(), autosave: true,
    version: { _status: 'draft', title: 'A' } }
  const token = revisionToken('news-articles', documentId, revision)
  assert.equal(token, revisionToken('news-articles', documentId, { ...revision, latest: false } as never))
  for (const value of [{ ...revision, autosave: false }, { ...revision, version: { ...revision.version, title: 'B' } },
    { ...revision, version: { ...revision.version, _status: 'published' } }]) {
    assert.notEqual(token, revisionToken('news-articles', documentId, value))
  }
  assert.notEqual(token, revisionToken('news-articles', randomUUID(), revision))
  assert.throws(() => readRestoreTarget({ target: 'news-home', documentId: 'news-home', sourceVersionId: revision.id, overrideAccess: true }))
  for (const target of [['news-articles'], ['news-home'], { toString: () => 'news-home' }]) {
    assert.throws(() => readRestoreTarget({ target, documentId, sourceVersionId: revision.id }), /invalid_restore_request/)
  }
})
