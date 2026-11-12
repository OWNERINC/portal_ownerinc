// Independent expansion acceptance: real SQL/routes/files/FFmpeg; synthetic identities.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument, cargoA } from './check-pages.mjs';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';

export async function checkPagesPilotDatabase() {
  const fixtures = await createPagesMediaFixtures();
  const oldId = randomUUID(), oldRevision = randomUUID(), oldMedia = randomUUID();
  const oldDocument = pageDocument('Snapshot v1 anterior à expansão');
  let h;
  let assertions = 0;
  const status = (response, expected) => { assert.equal(response.status, expected, JSON.stringify(response.body)); assertions++; return response.body; };
  const key = () => ({ client_mutation_id: randomUUID() });
  try {
    h = await createPagesDatabaseHarness({ afterFoundation: async db => {
      await db.query('INSERT INTO pages(id,author_uid) VALUES($1,$2)', [oldId, 'author']);
      await db.query("INSERT INTO page_revisions(id,page_id,schema_version,title,document,created_by) VALUES($1,$2,1,$3,$4::jsonb,'author')", [oldRevision, oldId, oldDocument.metadata.title, JSON.stringify(oldDocument)]);
      await db.query('UPDATE pages SET draft_revision_id=$2 WHERE id=$1', [oldId, oldRevision]);
      await db.query("INSERT INTO page_media(id,page_id,uploaded_by,storage_key,mime_type,byte_size,width,height,sha256) VALUES($1,$2,'author',$3,'image/webp',20,2,2,$4)", [oldMedia, oldId, `pages-${oldMedia}.webp`, 'a'.repeat(64)]);
    } });
    const workspace = async (id, actor = 'author') => status(await h.api('get', `/${id}/workspace`, undefined, actor), 200);
    const save = async (id, document) => {
      const current = await workspace(id);
      return status(await h.api('put', `/${id}/draft`, { ...key(), expected_version: current.version, document }), 200);
    };
    const publish = async id => {
      const current = await workspace(id);
      return status(await h.api('post', `/${id}/publish`, { ...key(), expected_version: current.version, revision_id: current.draft_revision_id }, 'publisher'), 200);
    };
    const upload = async (id, kind, buffer, name, mutation = randomUUID(), actor = 'author', contentType) => {
      const call = h.request.post(`/api/pages/${id}/media`).set('Authorization', `Bearer ${actor}`).field('client_mutation_id', mutation).field('kind', kind);
      return call.attach('file', buffer, { filename: name, ...(contentType ? { contentType } : {}) });
    };
    assert.deepEqual((await workspace(oldId)).draft.document, oldDocument, '041 must preserve pre-existing v1 JSON and UUIDs');
    const migrated = (await h.db.query('SELECT * FROM page_media WHERE id=$1', [oldMedia])).rows[0];
    assert.equal(migrated.mime_type, 'image/webp');
    assert.equal(migrated.storage_key, `pages-${oldMedia}.webp`);
    assert.equal(migrated.kind, 'image');
    // Compare the effective bootstrap+pending-migrations shape with 040→041,
    // rather than equating SQL source text with the resulting database schema.
    const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
    const fresh = new PGlite();
    try {
      await fresh.exec('CREATE ROLE portal_api; CREATE ROLE portal_cron; CREATE TABLE users(uid TEXT PRIMARY KEY); CREATE TABLE job_titles(id UUID PRIMARY KEY)');
      const bootstrap = await readFile(new URL('../../api/db/schema.sql', import.meta.url), 'utf8');
      await fresh.exec(bootstrap.slice(bootstrap.indexOf('CREATE TABLE IF NOT EXISTS pages ('), bootstrap.indexOf('-- The legacy catalog seed')));
      for (const name of ['040_pages.sql', '041_pages_media.sql']) await fresh.exec(await readFile(new URL(`../../api/db/migrations/${name}`, import.meta.url), 'utf8'));
      for (const sql of [
        "SELECT table_name,column_name,is_nullable,data_type,column_default FROM information_schema.columns WHERE table_schema='public' AND (table_name='pages' OR table_name LIKE 'page_%') ORDER BY table_name,ordinal_position",
        "SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relname='pages' OR relname LIKE 'page_%') ORDER BY table_name,conname",
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND (tablename='pages' OR tablename LIKE 'page_%') ORDER BY tablename,indexname",
        "SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('portal_api','portal_cron') AND (table_name='pages' OR table_name LIKE 'page_%') ORDER BY grantee,table_name,privilege_type",
      ]) assert.deepEqual((await fresh.query(sql)).rows, (await h.db.query(sql)).rows, 'bootstrap+040+041 and populated 040→041 must converge');
    } finally { await fresh.close(); }
    await save(oldId, oldDocument);
    await publish(oldId);
    assert.deepEqual(status(await h.api('get', `/${oldId}`, undefined, 'reader'), 200).document, oldDocument);
    assert.deepEqual((await h.db.query('SELECT document FROM page_revisions WHERE id=$1', [oldRevision])).rows[0].document, oldDocument);

    const templates = status(await h.api('get', '/templates'), 200);
    assert.ok(templates.some(item => item.id === 'owner-news'), 'pilot must be a selectable generic template');
    const create = { ...key(), template_id: 'owner-news' };
    const created = status(await h.api('post', '', create), 201), id = created.id;
    assert.equal(status(await h.api('post', '', create), 201).id, id, 'template create retry');
    const initial = await workspace(id);
    const doc = structuredClone(initial.draft.document);
    assert.equal(doc.schema_version, 2);
    assert.deepEqual(doc.template, { id: 'owner-news', version: 1 });
    assert.equal(doc.sections.length, 5);
    assert.match(JSON.stringify(doc), /sintétic|demonstração/i);
    doc.metadata.audience.job_title_ids = [cargoA];
    const media = [];
    for (const [kind, name, mime] of [['gif', 'synthetic.gif', 'image/gif'], ['audio', 'synthetic.mp3', 'audio/mpeg'], ['video', 'synthetic.mp4', 'video/mp4']]) {
      const fixture = fixtures.files[name], mutation = randomUUID();
      for (const actor of ['other', 'publisher', 'noethics']) status(await upload(id, kind, fixture.buffer, name, randomUUID(), actor), 403);
      const before = (await h.db.query('SELECT count(*)::int AS n FROM page_media WHERE page_id=$1', [id])).rows[0].n;
      const ack = status(await upload(id, kind, fixture.buffer, name, mutation), 201);
      assert.equal(ack.kind, kind);
      assert.equal(ack.mime_type, mime);
      assert.ok(ack.duration_ms > 0, `${kind} trusted duration`);
      const replay = status(await upload(id, kind, fixture.buffer, name, mutation), 201);
      assert.equal(replay.media_id, ack.media_id);
      assert.equal((await h.db.query('SELECT count(*)::int AS n FROM page_media WHERE page_id=$1', [id])).rows[0].n, before + 1);
      status(await upload(id, kind, fixtures.files[name.replace('synthetic', 'different')].buffer, name, mutation), 409);
      status(await h.api('get', `/${id}/media/${ack.media_id}`, undefined, 'reader'), 404);
      status(await h.request.get(`/api/pages/${id}/media/${ack.media_id}`), 401);
      status(await h.api('get', `/${id}/media/${ack.media_id}?preview=1`, undefined, 'other'), 404);
      const staged = await h.api('get', `/${id}/media/${ack.media_id}?preview=1`);
      status(staged, 200);
      assert.match(staged.headers['content-type'], new RegExp(mime));
      assert.match(staged.headers['cache-control'], /private.*no-store/);
      assert.equal(staged.headers['x-content-type-options'], 'nosniff');
      media.push({ ...ack, kind });
    }
    status(await upload(id, 'video', fixtures.files['unsupported-codec.mp4'].buffer, 'renamed.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['extra-audio-track.mp4'].buffer, 'extra.mp4'), 415);
    status(await upload(id, 'gif', fixtures.files['too-many-frames.gif'].buffer, 'frames.gif'), 415);
    status(await upload(id, 'audio', fixtures.files['too-long.mp3'].buffer, 'long.mp3'), 415);
    status(await upload(id, 'video', fixtures.files['too-fast.mp4'].buffer, 'fast.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['midstream-resolution.mp4'].buffer, 'changing-resolution.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['midstream-pixels.mp4'].buffer, 'changing-pixels.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['encrypted.mp4'].buffer, 'encrypted.mp4'), 415);
    const innocentMetadata = status(await upload(id, 'video', fixtures.files['innocent-metadata.mp4'].buffer, 'innocent.mp4'), 201);
    assert.equal(innocentMetadata.kind, 'video', 'ordinary metadata words must not trigger encryption/reference rejection');
    const externalReference = Buffer.from(fixtures.files['synthetic.mp4'].buffer);
    const urlEntry = externalReference.indexOf(Buffer.from('url '));
    assert.ok(urlEntry > 0 && externalReference[urlEntry + 7] === 1, 'fixture has a self-contained MOV data reference');
    externalReference[urlEntry + 7] = 0;
    status(await upload(id, 'video', externalReference, 'external-reference.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['synthetic.mp4'].buffer.subarray(0, 64), 'truncated.mp4'), 415);
    status(await upload(id, 'video', fixtures.files['synthetic.mp3'].buffer, 'fake.mp4', randomUUID(), 'author', 'video/mp4'), 415);
    for (const [kind, name, mib] of [['gif', 'synthetic.gif', 8], ['audio', 'synthetic.mp3', 10], ['video', 'synthetic.mp4', 25]]) {
      const oversized = Buffer.alloc(mib * 1024 * 1024 + 1);
      fixtures.files[name].buffer.copy(oversized);
      status(await upload(id, kind, oversized, name), 413);
    }
    const last = doc.sections.at(-1).rows.at(-1).columns[0].blocks;
    const [gif, audio, video] = media;
    for (const [mediaId, assignment] of [[gif.media_id, 'duration_ms=NULL'], [audio.media_id, 'width=10'], [video.media_id, 'height=NULL'], [video.media_id, "mime_type='audio/mpeg'"]]) {
      await assert.rejects(h.db.query(`UPDATE page_media SET ${assignment} WHERE id=$1`, [mediaId]), /check|not.null|constraint/i, `kind-specific SQL constraint: ${assignment}`);
    }
    last.push({ id: randomUUID(), type: 'gif', media_id: gif.media_id, alt: 'Animação geométrica sintética', caption: 'Fixture sem pessoas reais.', credit: 'Gerada localmente com FFmpeg.' });
    last.push({ id: randomUUID(), type: 'audio', media_id: audio.media_id, title: 'Tom de demonstração', transcript: 'Tom senoidal sintético de dois segundos; não contém fala.' });
    last.push({ id: randomUUID(), type: 'video', media_id: video.media_id, title: 'Vídeo de demonstração', transcript: 'Padrão geométrico com tom sintético. Não contém fala.', captions: [{ start_ms: 0, end_ms: 1500, text: 'Padrão de teste e tom sintético.' }] });
    const row = doc.sections[2].rows[0];
    if (row.layout === 'single') { row.layout = 'two_equal'; row.columns.push({ id: randomUUID(), blocks: [] }); }
    row.columns[1].blocks.push({ id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Coluna direita: leitura após a esquerda.' }] }] } });
    await save(id, doc);
    const saved = await workspace(id);
    assert.equal((await h.db.query('SELECT schema_version FROM page_revisions WHERE id=$1', [saved.draft_revision_id])).rows[0].schema_version, 2);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM page_revision_media WHERE revision_id=$1', [saved.draft_revision_id])).rows[0].n, 3);
    for (const actor of ['publisher', 'super', 'other']) status(await h.api('put', `/${id}/draft`, { ...key(), expected_version: saved.version, document: doc }, actor), 403);
    for (const [label, mutate] of [
      ['type confusion', value => { value.sections.at(-1).rows.at(-1).columns[0].blocks.at(-1).media_id = audio.media_id; }],
      ['duplicate IDs', value => { value.sections[0].id = value.sections[1].id; }],
      ['third column', value => { value.sections[2].rows[0].columns.push({ id: randomUUID(), blocks: [] }); }],
      ['unsafe button', value => { value.sections[0].rows[0].columns[0].blocks.push({ id: randomUUID(), type: 'button', label: 'Não executar', preset: 'primary', destination: { type: 'url', value: 'javascript:alert(1)' } }); }],
      ['missing section', value => { value.sections[0].rows[0].columns[0].blocks.push({ id: randomUUID(), type: 'button', label: 'Destino ausente', preset: 'primary', destination: { type: 'section', value: randomUUID() } }); }],
      ['invalid captions', value => { value.sections.at(-1).rows.at(-1).columns[0].blocks.at(-1).captions[0].end_ms = -1; }],
      ['caption beyond video duration', value => { value.sections.at(-1).rows.at(-1).columns[0].blocks.at(-1).captions[0].end_ms = 90000; }],
    ]) {
      const bad = structuredClone(doc); mutate(bad);
      status(await h.api('put', `/${id}/draft`, { ...key(), expected_version: saved.version, document: bad }), 400);
      assert.equal((await workspace(id)).version, saved.version, label);
    }
    const foreign = status(await h.api('post', '', { ...key(), template_id: 'owner-news' }), 201);
    const foreignDocument = (await workspace(foreign.id)).draft.document;
    foreignDocument.sections[0].rows[0].columns[0].blocks.push(structuredClone(last.at(-1)));
    const foreignWorkspace = await workspace(foreign.id);
    status(await h.api('put', `/${foreign.id}/draft`, { ...key(), expected_version: foreignWorkspace.version, document: foreignDocument }), 400);
    // Registered private bytes must be removed on an unambiguous audit rollback.
    const filesBefore = (await readdir(join(h.directory, 'pages-private'))).sort();
    const recordsBefore = (await h.db.query('SELECT count(*)::int AS n FROM page_media')).rows[0].n;
    await h.db.exec("CREATE FUNCTION reject_pilot_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic media audit failure'; END $$; CREATE TRIGGER reject_pilot_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_pilot_audit()");
    status(await upload(id, 'audio', fixtures.files['synthetic.mp3'].buffer, 'rollback.mp3'), 500);
    await h.db.exec('DROP TRIGGER reject_pilot_audit ON audit_log; DROP FUNCTION reject_pilot_audit()');
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM page_media')).rows[0].n, recordsBefore);
    assert.deepEqual((await readdir(join(h.directory, 'pages-private'))).sort(), filesBefore);
    await publish(id);
    assert.deepEqual(status(await h.api('get', `/${id}`, undefined, 'reader'), 200).document, doc);
    for (const asset of media) {
      const path = `/${id}/media/${asset.media_id}`;
      const bytes = await h.request.get(`/api/pages${path}`).set('Authorization', 'Bearer reader').set('Range', 'bytes=0-9');
      status(bytes, 200);
      assert.equal(bytes.headers['content-range'], undefined, 'full download, not range streaming');
      assert.equal(Number(bytes.headers['content-length']), asset.byte_size);
      for (const actor of ['outsider', 'noethics', 'publisher']) status(await h.api('get', path, undefined, actor), actor === 'noethics' ? 403 : 404);
    }
    const publishedRevision = (await workspace(id)).published_revision_id;
    const withoutMedia = structuredClone(doc);
    const column = withoutMedia.sections.at(-1).rows.at(-1).columns[0];
    column.blocks = column.blocks.filter(block => !['gif', 'audio', 'video'].includes(block.type));
    await save(id, withoutMedia);
    for (const asset of media) status(await h.api('get', `/${id}/media/${asset.media_id}`, undefined, 'reader'), 200);
    await publish(id);
    for (const asset of media) {
      status(await h.api('get', `/${id}/media/${asset.media_id}`, undefined, 'reader'), 404);
      status(await h.api('get', `/${id}/media/${asset.media_id}?revision_id=${publishedRevision}`, undefined, 'publisher'), 200);
      status(await h.api('get', `/${id}/media/${asset.media_id}?revision_id=${publishedRevision}`, undefined, 'reader'), 403);
    }
    let current = await workspace(id);
    status(await h.api('post', `/${id}/archive`, { ...key(), expected_version: current.version }, 'publisher'), 200);
    for (const asset of media) status(await h.api('get', `/${id}/media/${asset.media_id}?revision_id=${publishedRevision}`, undefined, 'publisher'), 404);
    current = await workspace(id);
    status(await h.api('post', `/${id}/restore`, { ...key(), expected_version: current.version }, 'publisher'), 200);
    assert.equal((await workspace(id)).published_revision_id, null);
    // Historical metadata consumes quota even if it is not in the current draft.
    const quotaPage = status(await h.api('post', '', { ...key(), template_id: 'owner-news' }), 201);
    const seed = status(await upload(quotaPage.id, 'audio', fixtures.files['synthetic.mp3'].buffer, 'quota.mp3'), 201);
    await h.db.query(`INSERT INTO page_media SELECT (jsonb_populate_record(NULL::page_media,
      to_jsonb(m) || jsonb_build_object('id',gen_random_uuid(),'storage_key','pages-' || gen_random_uuid() || '.mp3'))).*
      FROM page_media m CROSS JOIN generate_series(1,49) WHERE m.id=$1`, [seed.media_id]);
    status(await upload(quotaPage.id, 'audio', fixtures.files['synthetic.mp3'].buffer, 'over-count.mp3'), 413);
    const bytesPage = status(await h.api('post', '', { ...key(), template_id: 'owner-news' }), 201);
    await h.db.query(`INSERT INTO page_media SELECT (jsonb_populate_record(NULL::page_media,
      to_jsonb(m) || jsonb_build_object('id',gen_random_uuid(),'page_id',$2::uuid,
        'storage_key','pages-' || gen_random_uuid() || '.mp4','byte_size',26214400))).*
      FROM page_media m CROSS JOIN generate_series(1,4) WHERE m.id=$1`, [video.media_id, bytesPage.id]);
    status(await upload(bytesPage.id, 'audio', fixtures.files['synthetic.mp3'].buffer, 'over-bytes.mp3'), 413);
    for (const table of ['page_revisions', 'page_media', 'page_revision_media', 'page_revision_job_titles']) {
      const privileges = (await h.db.query('SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_name=$2', ['portal_api', table])).rows.map(item => item.privilege_type);
      assert.ok(privileges.includes('SELECT') && privileges.includes('INSERT'));
      assert.ok(!privileges.includes('UPDATE') && !privileges.includes('DELETE'));
    }
    console.log(`Pages pilot database PASS: ${assertions} HTTP checks; populated 040→041, v1 preservation, v2 pilot, real GIF/MP3/MP4 probe/decode, typed private access, replay, rollback, publication/history/archive. PGlite serialized; Firebase synthetic.`);
  } finally { await h?.close(); await fixtures.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPagesPilotDatabase();
