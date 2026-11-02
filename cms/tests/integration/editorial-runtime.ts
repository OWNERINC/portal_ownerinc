import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { BasePayload, createLocalReq } from 'payload'
import { restoreNewsDraft } from '../../src/publication/restore-draft'
import { withCmsTransaction } from '../../src/publication/transaction'
import { NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger'

const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER || ''
const action = process.env.PAYLOAD_EDITORIAL_RUNTIME_ACTION || ''
const directory = path.resolve(process.env.PAYLOAD_MANUAL_RUNTIME_EVIDENCE || '')
const uploadDir = path.resolve(process.env.CMS_UPLOAD_DIR || '')
const origin = process.env.PAYLOAD_EDITORIAL_RUNTIME_ORIGIN || ''
if (!/^[0-9a-f]{32}$/u.test(marker) || !['baseline', 'exercise', 'retained-held', 'retained-editorial'].includes(action) ||
  !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) || path.dirname(uploadDir) !== directory || path.basename(uploadDir) !== 'uploads') {
  throw new Error('editorial_runtime_disposable_contract_invalid')
}
const evidenceFile = path.join(directory, 'editorial-proof.json')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const headers = { 'Content-Type': 'application/json', Cookie: `__Host-ownerinc-editorial=editor-${marker}`,
  Origin: 'https://portal.manual.invalid', 'Sec-Fetch-Site': 'same-origin' }
const actor = { uid: `manual-editor-${marker}`, email: `manual-${marker}@example.invalid`, name: null, canManageNews: true }
async function http(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${origin}/editorial/api${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, json: await response.json(), headers: response.headers }
}
async function reader(action: string, input: unknown) {
  const response = await fetch(`${origin}/editorial/api/portal-news/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PORTAL_TO_PAYLOAD_SECRET}`, 'X-Request-Id': randomUUID() },
    body: JSON.stringify({ actor: { ...actor, canManageNews: false }, input }) })
  return { status: response.status, json: await response.json().catch(() => null) }
}

test(`real PostgreSQL/native HTTP editorial profile: ${action}; Portal transport is a double`, async () => {
  const db = new pg.Client({ connectionString: process.env.CMS_DATABASE_URL })
  await db.connect()
  // Actual physical catalog, including held's intentionally omitted in-memory autosave fields.
  const catalog = async () => hash((await db.query(`SELECT kind, identity, definition FROM (
    SELECT 'column' kind, c.table_name||'.'||c.column_name identity, row_to_json(c)::text definition
    FROM information_schema.columns c WHERE table_schema='public'
    UNION ALL SELECT 'index', tablename||'.'||indexname, indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'constraint', c.conrelid::regclass::text||'.'||c.conname, pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
    UNION ALL SELECT 'enum', t.typname||'.'||e.enumlabel, e.enumsortorder::text FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'migration', name, row_to_json(m)::text FROM payload_migrations m
    ) inventory ORDER BY kind, identity, definition`)).rows)
  const inventory = async () => {
    const rows: unknown[] = []
    for (const table of NEWS_MUTATION_TABLES) {
      assert.match(table, /^[_a-z][_a-z0-9]*$/u)
      rows.push([table, (await db.query(`SELECT row_to_json(t) AS row FROM public."${table}" t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows])
    }
    return hash(rows)
  }
  const versions = async (id: string) => (await db.query('SELECT * FROM _news_articles_v WHERE parent_id=$1 ORDER BY updated_at DESC,id', [id])).rows
  const live = async (id: string) => (await db.query('SELECT row_to_json(t) AS row FROM news_articles t WHERE id=$1', [id])).rows[0].row
  try {
    const ready = await fetch(`${origin}/editorial/ready`)
    assert.equal(ready.status, 200)
    assert.equal(ready.headers.get('x-cms-editorial-profile'), action === 'baseline' || action === 'retained-held' ? 'held-v1' : 'editorial-v1')
    if (action === 'baseline') {
      await writeFile(evidenceFile, JSON.stringify({ catalog: await catalog() }), { mode: 0o600 }); return
    }
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(await catalog(), evidence.catalog, 'same database, no DDL between profile restarts')
    if (action !== 'exercise') {
      assert.equal(await inventory(), evidence.inventory, 'all retained content/version/media/audit/migration lineage survives restart')
      assert.equal(createHash('sha256').update(await readFile(path.join(uploadDir, evidence.media.filename))).digest('hex'), evidence.media.sha256,
        'retained editorial upload bytes survive every profile restart')
      const history = await http(`/news-articles/versions?where[parent][equals]=${evidence.id}`)
      assert.equal(history.status, action === 'retained-held' ? 403 : 200)
      if (action === 'retained-held') {
        assert.equal((await http(`/news-articles/${evidence.id}?draft=true&autosave=true`, { title: 'Held refusal' }, 'PATCH')).status, 403)
        assert.equal(await inventory(), evidence.inventory)
      }
      return
    }
    const mediaBytes = Buffer.from('%PDF-1.7\neditorial retained-only reference\n%%EOF\n')
    const form = new FormData(); form.append('file', new Blob([mediaBytes], { type: 'application/pdf' }), 'editorial.pdf'); form.append('_payload', '{}')
    const upload = await fetch(`${origin}/editorial/api/news-media`, { method: 'POST',
      headers: { Cookie: headers.Cookie, Origin: headers.Origin, 'Sec-Fetch-Site': 'same-origin' }, body: form })
    assert.equal(upload.status, 201); const media = (await upload.json()).doc
    const data = { title: 'Editorial A', category: 'Editorial runtime',
      editorial: { version: 1, kind: 'article', summary: 'Synthetic editorial proof', author: '', source_label: '', source_date: null },
      body: [{ blockType: 'paragraph', text: 'A' }, { blockType: 'pdf', media: media.id, title: 'A attachment' }], _status: 'published' }
    // These positive controls also prove Next resolves the encoded paths below.
    const created = await http('/%6Eews-articles?depth=0', data); assert.equal(created.status, 201)
    const id = created.json.doc.id, source = (await versions(id))[0].id
    assert.notEqual(source, id)
    assert.equal((await http(`/%6Eews-articles/${id}?draft=false&autosave=false`, { title: 'Editorial B', body: [{ blockType: 'paragraph', text: 'B' }], _status: 'published' }, 'PATCH')).status, 200)
    const base = await live(id), publicB = await reader('detail', { id })
    assert.equal(publicB.status, 200); assert.equal(publicB.json.title, 'Editorial B')
    assert.equal((await reader('asset', { id: media.id, preview: false, range: null })).status, 403)
    assert.equal((await http(`/news-media/${media.id}`, undefined, 'DELETE')).status, 409)
    const homeSave = (headline: string, extra = {}) => http('/%67lobals/%6Eews-home?depth=0', { eyebrow: 'News', headline, summary: 'Home proof', _status: 'published', ...extra })
    assert.equal((await homeSave('Home A')).status, 200)
    const homeSource = (await db.query('SELECT id FROM _news_home_v WHERE latest=true')).rows[0].id
    assert.equal((await homeSave('Home B')).status, 200)
    const homeBase = (await db.query('SELECT row_to_json(t) AS row FROM news_home t')).rows
    const homePublic = await reader('home', {})
    // Real HTTP parsing, native persistence and reader isolation. Ambiguous raw
    // controls must not become an implicit explicit publication after coercion.
    const ambiguous = ['draft=true&draft=false', 'draft=false&draft=true', 'draft=true&draft=true',
      'autosave=true&autosave=false', 'autosave=false&autosave=true', 'draft[]=true', 'draft[0]=true',
      'draft[x]=false', 'autosave%5B%5D=true', 'draft=TRUE', 'draft=1', 'draft=', 'autosave=null', 'autosave',
      ...['draft', 'autosave'].flatMap(key => [
        `%5B${key}%5D=true&%5B${key}%5D=false`, `[${key}]=true`, `${key}=false&[${key}]=true`,
        `[${key}][0]=true`, `[${key}][bad]=false`, `[${key}]suffix=true`, `[${key}]]=true`,
        `[${key}][=true`, `[${key}=true`, `[${key}]=`,
      ])]
    for (const [route, method, changed] of [
      ['/news-articles', 'POST', { ...data, title: 'Ambiguous create' }],
      [`/news-articles/${id}`, 'PATCH', { title: 'Ambiguous update', _status: 'published' }],
      ['/globals/news-home', 'POST', { headline: 'Ambiguous Home', _status: 'published' }],
      ['/%6Eews-articles', 'POST', { ...data, title: 'Encoded ambiguous create' }],
      [`/%6Eews-articles/${id}`, 'PATCH', { title: 'Encoded ambiguous update', _status: 'published' }],
      ['/%67lobals/%6Eews-home', 'POST', { headline: 'Encoded ambiguous Home', _status: 'published' }],
    ] as const) {
      const before = await inventory()
      for (const query of ambiguous) {
        const denied = await http(`${route}?${query}`, changed, method)
        assert.equal(denied.status, 400, `${route}?${query}`)
        assert.equal(denied.headers.get('cache-control'), 'private,no-store')
        assert.equal(await inventory(), before, 'no live row, version, audit or revision changes')
        assert.deepEqual(await live(id), base)
        assert.deepEqual((await db.query('SELECT row_to_json(t) AS row FROM news_home t')).rows, homeBase)
        assert.deepEqual(await reader('detail', { id }), publicB)
        assert.deepEqual(await reader('home', {}), homePublic)
      }
    }
    for (const [route, method, changed] of [
      [`/%6Eews-articles/${id}`, 'PATCH', { title: 'Native UI draft', _status: 'published' }],
      ['/%67lobals/%6Eews-home', 'POST', { headline: 'Native UI draft', _status: 'published' }],
    ] as const) {
      const saved = await http(`${route}?autosave=true&depth=0&draft=true&fallback-locale=null`, changed, method)
      assert.equal(saved.status, 200); assert.equal(saved.json[method === 'PATCH' ? 'doc' : 'result']._status, 'draft')
      assert.deepEqual(await live(id), base)
      assert.deepEqual((await db.query('SELECT row_to_json(t) AS row FROM news_home t')).rows, homeBase)
      assert.deepEqual(await reader('detail', { id }), publicB)
      assert.deepEqual(await reader('home', {}), homePublic)
    }
    const compare = async (target: string, documentId: string, sourceVersionId: string) => {
      const query = new URLSearchParams({ target, documentId, sourceVersionId })
      const result = await http(`/news-restore-draft?${query}`); assert.equal(result.status, 200)
      assert.equal(result.headers.get('cache-control'), 'private,no-store')
      return { target, documentId, sourceVersionId, sourceRevisionToken: result.json.sourceRevisionToken, expectedHeadToken: result.json.expectedHeadToken }
    }
    const stale = await compare('news-articles', id, source)
    for (const title of ['', 'Autosave C']) {
      const saved = await http(`/news-articles/${id}?autosave=true`, { title, _status: 'published' }, 'PATCH')
      assert.equal(saved.status, 200); assert.equal(saved.json.doc._status, 'draft')
      assert.deepEqual(await live(id), base); assert.deepEqual(await reader('detail', { id }), publicB)
    }
    assert.equal((await http('/news-restore-draft', stale)).status, 409)
    const checkpoint = await http(`/saved-preview?target=article&documentId=${id}`)
    assert.equal(checkpoint.status, 409)
    const save = await http(`/news-articles/${id}?draft=true&autosave=false`, { title: 'Checkpoint C' }, 'PATCH')
    assert.equal(save.status, 200)
    const stable = (await versions(id)).find(row => row.latest)
    assert.equal(stable.autosave, false)
    const preview = await http(`/saved-preview?target=article&documentId=${id}`); assert.equal(preview.status, 200)
    assert.equal(preview.json.versionId, stable.id)
    const restoreInput = await compare('news-articles', id, source)
    assert.equal((await http('/news-restore-draft', { ...restoreInput, documentId: randomUUID() })).status, 404)
    const beforeFailure = await inventory(), file = path.join(uploadDir, media.filename), hidden = `${file}.test-held`
    await rename(file, hidden)
    try { assert.equal((await http('/news-restore-draft', restoreInput)).status, 503) }
    finally { await rename(hidden, file) }
    assert.equal(await inventory(), beforeFailure, 'missing media bytes roll back every restored version/audit')
    const native = new BasePayload()
    try {
      const { createCmsConfig } = await import('../../src/payload.config')
      const config = await createCmsConfig()
      config.collections.find(c => c.slug === 'news-audit')!.hooks.beforeChange.push(() => { throw new Error('test_audit_failure') })
      config.typescript.autoGenerate = false
      await native.init({ config, disableOnInit: true })
      const identity = await native.find({ collection: 'portal-editors', where: { portalUid: { equals: actor.uid } }, limit: 1 })
      const foreign = await native.create({ collection: 'portal-editors', overrideAccess: true,
        data: { portalUid: `lock-owner-${marker}`, email: `lock-${marker}@example.invalid` } })
      for (const [target, documentId, sourceVersionId] of [['news-articles', id, source], ['news-home', 'news-home', homeSource]] as const) {
        const input = await compare(target, documentId, sourceVersionId)
        const query = new URLSearchParams({ target, documentId, sourceVersionId })
        const canRestore = async () => {
          const response = await http(`/news-restore-draft?${query}`)
          assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private,no-store')
          assert.equal(JSON.stringify(response.json).includes(foreign.id), false, 'no foreign lock identity exposed')
          return response.json.canRestore
        }
        const lock = await native.create({ collection: 'payload-locked-documents', overrideAccess: true, depth: 0,
          data: { user: { relationTo: 'portal-editors', value: foreign.id },
            ...(target === 'news-articles' ? { document: { relationTo: 'news-articles', value: id } } : { globalSlug: 'news-home' }) } })
        const storedLock = await native.findByID({ collection: 'payload-locked-documents', id: lock.id, depth: 0 })
        assert.equal(await canRestore(), false)
        assert.equal((await http('/news-restore-draft', input)).status, 409)
        assert.equal(await canRestore(), false, '409 refresh remains unavailable')
        assert.deepEqual(await native.findByID({ collection: 'payload-locked-documents', id: lock.id, depth: 0 }), storedLock,
          'comparison never releases or refreshes the lock')
        // Fixture-only native adapter writes, on the actual transaction: no clock
        // sleep or production override is added to exercise expired/self locks.
        await withCmsTransaction(native, undefined, req => native.db.updateOne({ collection: 'payload-locked-documents', id: lock.id,
          req, data: { updatedAt: new Date(Date.now() - 301_000).toISOString() } }))
        assert.equal(await canRestore(), true)
        await native.update({ collection: 'payload-locked-documents', id: lock.id, overrideAccess: true,
          data: { user: { relationTo: 'portal-editors', value: identity.docs[0].id } } })
        assert.equal(await canRestore(), true)
        await native.delete({ collection: 'payload-locked-documents', id: lock.id, overrideAccess: true })
        assert.equal(await canRestore(), true)
        assert.equal(await inventory(), beforeFailure, 'comparison/lock conflicts never write editorial revisions')
      }
      const req = await createLocalReq({ user: { ...identity.docs[0], collection: 'portal-editors', portalActor: actor,
        portalExpiresAt: new Date(Date.now() + 3600000).toISOString() } as never,
        req: new Request(`${origin}/editorial/api/news-restore-draft`, { method: 'POST', headers }) }, native)
      await assert.rejects(restoreNewsDraft(req, restoreInput), /test_audit_failure/)
      assert.equal(await inventory(), beforeFailure, 'real transaction rolls back native version after audit failure')
    } finally { await native.destroy() }
    const results = await Promise.all([http('/news-restore-draft', restoreInput), http('/news-restore-draft', restoreInput)])
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
    const restored = results.find(result => result.status === 200)!.json
    assert.equal(restored._status, 'draft'); assert.notEqual(restored.versionId, source)
    assert.deepEqual(await live(id), base); assert.deepEqual(await reader('detail', { id }), publicB)
    const row = (await versions(id)).find(row => row.id === restored.versionId)
    assert.equal(row.version_title, 'Editorial A'); assert.equal(row.autosave, false)
    for (const field of ['created_at', 'published_at', 'publication_generation', 'legacy_document_id', 'legacy_source_id', 'legacy_revision_id', 'imported_at']) {
      assert.deepEqual(row[`version_${field}`], base[field] === null ? null : /_at$/u.test(field) ? new Date(base[field]) : base[field], field)
    }
    const audit = (await db.query('SELECT * FROM news_audit WHERE version_id=$1', [restored.versionId])).rows[0]
    assert.equal(audit.action, 'draft_saved'); assert.equal(audit.details.saveKind, 'restore'); assert.equal(audit.details.sourceVersionId, source)
    assert.equal((await http(`/news-articles/${id}?autosave=true`, { title: 'Later autosave' }, 'PATCH')).status, 200)
    assert.equal((await versions(id)).find(row => row.id === restored.versionId).version_title, 'Editorial A')
    assert.equal((await http('/news-restore-draft', restoreInput)).status, 409)
    const homeInput = await compare('news-home', 'news-home', homeSource)
    assert.equal((await http('/news-restore-draft', homeInput)).status, 200)
    assert.deepEqual((await db.query('SELECT row_to_json(t) AS row FROM news_home t')).rows, homeBase)
    assert.deepEqual(await reader('home', {}), homePublic)
    assert.equal((await http(`/globals/news-home/versions/${homeSource}`, {}, 'POST')).status, 403)
    assert.equal((await http(`/news-articles/versions/${source}`, {}, 'POST')).status, 403)
    assert.equal((await http(`/news-articles/${id}`, { title: 'Editorial A explicitly published', _status: 'published' }, 'PATCH')).status, 200)
    assert.equal((await reader('detail', { id })).json.title, 'Editorial A explicitly published')
    assert.equal(await catalog(), evidence.catalog)
    await writeFile(evidenceFile, JSON.stringify({ ...evidence, id, source, restored: restored.versionId, inventory: await inventory(),
      media: { filename: media.filename, sha256: createHash('sha256').update(mediaBytes).digest('hex') } }), { mode: 0o600 })
  } finally { await db.end() }
})
