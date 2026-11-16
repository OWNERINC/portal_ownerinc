// Tasks 5/6: actual private upload, aliases, API authorization and SQL projections in a new
// disposable PGlite database. No remote database, real identity or service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPagesDatabaseHarness, cargoA, pageDocument } from './check-pages.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { featureDocument, referenceMedia } from '../helpers/pages-reference-document.mjs';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { createPagesRouter } = require('./pages/router');
const blocks = document => document.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
const find = (document, type) => blocks(document).find(block => block.type === type);
const key = () => ({ client_mutation_id: randomUUID() });

export async function checkPagesV3Database() {
  await checkPagesAliasesDatabase();
  const fixtures = await createPagesMediaFixtures();
  let h;
  let assertions = 0;
  const status = (response, expected) => { assert.equal(response.status, expected, JSON.stringify(response.body)); assertions++; return response.body; };
  try {
    h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
    // Same real authentication/SQL/files, but a separate router instance with its
    // DEFAULT flag disabled. No process.env mutation or production flag change.
    assert.notEqual(process.env.PAGES_V3_WRITES_ENABLED, 'true', 'run with production writer disabled');
    h.app.use('/api/pages-disabled', createPagesRouter({ pool: h.pool, authenticate: h.authenticate, uploadDirectory: h.directory }));
    const disabled = async (method, path, body, actor = 'author') => {
      const request = h.request[method](`/api/pages-disabled${path}`).set('Authorization', `Bearer ${actor}`);
      return body === undefined ? await request : await request.send(body);
    };
    const ws = async id => status(await h.api('get', `/${id}/workspace`), 200);
    const count = async (table, where = '', parameters = []) => (await h.db.query(`SELECT count(*)::int AS n FROM ${table} ${where}`, parameters)).rows[0].n;
    const snapshot = async id => ({
      page: (await h.db.query('SELECT * FROM pages WHERE id=$1', [id])).rows,
      revisions: await count('page_revisions'), media: await count('page_media'),
      mediaRefs: await count('page_revision_media'), audience: await count('page_revision_job_titles'),
      requests: await count('page_requests'), audit: await count('audit_log'),
    });
    const noWrite = async (id, action, expected, reason) => {
      const before = await snapshot(id);
      const body = status(await action(), expected); if (reason) assert.equal(body.reason, reason);
      assert.deepEqual(await snapshot(id), before, `${reason}: no revision/projection/head/audit/receipt may persist`);
    };
    const upload = (id, kind, bytes, name, actor = 'author') => {
      const request = h.request.post(`/api/pages/${id}/media`).set('Authorization', `Bearer ${actor}`).field('client_mutation_id', randomUUID());
      if (kind !== 'image') request.field('kind', kind);
      return request.attach(kind === 'image' ? 'image' : 'file', bytes, name);
    };
    const saveBody = async (id, document) => ({ expected_version: (await ws(id)).version, ...key(), document });
    const publishBody = async id => { const current = await ws(id); return { expected_version: current.version, revision_id: current.draft_revision_id, ...key() }; };
    // Inject only loss of the COMMIT acknowledgement after the real DB commits.
    // Unlike an SQL fake, persisted revisions/receipts/files remain observable.
    const loseCommitAck = async action => {
      const original = h.pool.connect; let armed = true;
      h.pool.connect = async () => {
        const client = await original();
        return { release: error => client.release(error), async query(sql, parameters) {
          const result = await client.query(sql, parameters);
          if (armed && sql === 'COMMIT') { armed = false; throw new Error('synthetic lost COMMIT acknowledgement'); }
          return result;
        } };
      };
      try { status(await action(), 500); assert.equal(armed, false); } finally { h.pool.connect = original; }
    };

    const catalog = status(await disabled('get', '/templates'), 200);
    assert.deepEqual(catalog.map(item => [item.id, item.schema_version]), [['comunicado', 1], ['owner-news', 2]]);
    const legacy = [];
    for (const template of catalog) {
      const created = status(await disabled('post', '', { template_id: template.id, ...key() }), 201);
      const current = status(await disabled('get', `/${created.id}/workspace`), 200);
      assert.deepEqual(current.document_support, { read_versions: [1,2,3], write_versions: [1,2] });
      assert.equal(current.draft.document.schema_version, template.schema_version);
      assert.equal(current.capabilities.edit, true);
      const document = structuredClone(current.draft.document); document.metadata.audience.job_title_ids = [cargoA];
      status(await disabled('put', `/${created.id}/draft`, { expected_version: 0, ...key(), document }), 200);
      legacy.push({ id: created.id, document });
    }
    const id = legacy[0].id;
    const workspace = await ws(id);
    assert.deepEqual(workspace.document_support, { read_versions: [1,2,3], write_versions: [1,2,3] });
    const asset = referenceMedia()[0];
    for (const actor of ['other', 'publisher', 'super', 'reader']) status(await upload(id, 'image', asset.bytes, asset.file_name, actor), 403);
    const media = {};
    for (const label of ['image', 'gallery', 'download']) media[label] = status(await upload(id, 'image', asset.bytes, asset.file_name), 201);
    for (const [kind, name] of [['gif','synthetic.gif'], ['audio','synthetic.mp3'], ['video','synthetic.mp4']]) media[kind] = status(await upload(id, kind, fixtures.files[name].buffer, name), 201);
    const foreign = status(await upload(legacy[1].id, 'image', asset.bytes, asset.file_name), 201);
    const inventory = (await ws(id)).media;
    assert.deepEqual(inventory, Object.values(media).map(m=>({id:m.media_id,kind:m.kind})).sort((a,b)=>a.id.localeCompare(b.id)));
    assert.ok(!inventory.some(m=>m.id===foreign.media_id), 'workspace inventory is same-page, including unplaced uploads');
    for (const actor of ['publisher','super']) assert.deepEqual(status(await h.api('get', `/${id}/workspace`, undefined, actor),200).media, [], 'review-only workspace does not expose staged inventory');
    for (const actor of ['other','reader']) status(await h.api('get', `/${id}/workspace`, undefined, actor),403);
    const document = featureDocument();
    document.metadata.audience.job_title_ids = [cargoA];
    for (const block of blocks(document)) {
      if (block.type === 'image') { block.media_id = media.image.media_id; block.alt = 'Imagem sintética'; }
      if (block.type === 'gallery') {
        block.items[0].media_id = media.image.media_id; block.items[0].alt = 'Reuso da imagem';
        block.items.push({ id: randomUUID(), kind: 'image', media_id: media.gallery.media_id, alt: 'Segunda imagem', caption: '', credit: '' },
          { id: randomUUID(), kind: 'gif', media_id: media.gif.media_id, alt: 'Animação sintética', caption: '', credit: '' });
      }
      if (block.type === 'audio') { block.media_id = media.audio.media_id; block.transcript = 'Tom sintético sem fala.'; }
      if (block.type === 'button') block.action = { type: 'download', media_id: media.download.media_id, kind: 'image', file_name: 'guia.webp' };
      if (block.type === 'faq') for (const item of block.items) item.answer = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Resposta sintética para publicação.' }] }] };
    }
    document.sections[0].rows[0].columns[0].blocks.push({ id: randomUUID(), type: 'video', media_id: media.video.media_id, title: 'Vídeo sintético', transcript: 'Padrão e tom sintéticos.', captions: [{ start_ms: 0, end_ms: 1000, text: 'Padrão de teste.' }] });

    await noWrite(id, () => disabled('put', `/${id}/draft`, { expected_version: workspace.version, ...key(), document }), 409, 'document_version_disabled');
    // Honest draft placeholders have no private media association at all.
    const placeholders = structuredClone(document);
    for (const block of blocks(placeholders)) {
      if (Object.hasOwn(block, 'media_id')) block.media_id = null;
      if (block.type === 'gallery') for (const item of block.items) item.media_id = null;
      if (block.type === 'button') block.action = { type: 'section', value: placeholders.sections[0].id };
    }
    const placeholderAck = status(await h.api('put', `/${id}/draft`, await saveBody(id, placeholders)), 200);
    assert.equal(await count('page_revision_media', 'WHERE revision_id=$1', [placeholderAck.draft_revision_id]), 0);
    await noWrite(id, () => publishBody(id).then(body => disabled('post', `/${id}/publish`, body, 'publisher')), 400, 'media_not_ready');

    const body = await saveBody(id, document), before = await snapshot(id);
    // Transport and document budgets are independent. Neither may reserve a
    // receipt or leave a partially written feature graph behind.
    const oversized = structuredClone(document); oversized.metadata.summary = 'x'.repeat(1024 * 1024);
    await noWrite(id, () => h.api('put', `/${id}/draft`, { ...body, ...key(), document: oversized }), 413);
    await noWrite(id, () => h.api('put', `/${randomUUID()}/draft`, body), 404);
    const saved = status(await h.api('put', `/${id}/draft`, body), 200);
    assert.deepEqual(status(await disabled('put', `/${id}/draft`, body), 200), saved, 'flag-off replay before gate/CAS');
    const projected = (await h.db.query('SELECT media_id FROM page_revision_media WHERE revision_id=$1 ORDER BY media_id', [saved.draft_revision_id])).rows.map(row => row.media_id);
    assert.deepEqual(projected, Object.values(media).map(item => item.media_id).sort(), 'all typed uses, one association per media ID');
    assert.equal(await count('page_revisions'), before.revisions + 1);
    assert.equal(await count('audit_log'), before.audit + 1);
    assert.equal(await count('page_requests'), before.requests + 1);
    await noWrite(id, () => disabled('put', `/${id}/draft`, { ...body, ...key(), expected_version: saved.version }), 409, 'document_version_disabled');
    await noWrite(id, () => h.api('put', `/${id}/draft`, { ...body, document: { ...document, metadata: { ...document.metadata, title: 'Outra fotografia' } } }), 409, 'mutation_conflict');
    await noWrite(id, () => h.api('put', `/${id}/draft`, { ...body, ...key() }), 409, 'version_conflict');
    for (const old of legacy) for (const api of [h.api, disabled]) await noWrite(id, () => api('put', `/${id}/draft`, { ...key(), expected_version: saved.version, document: old.document }), 409, 'schema_downgrade_conflict');
    for (const actor of ['other', 'super']) await noWrite(id, () => disabled('put', `/${id}/draft`, body, actor), 403, 'author_only');
    await h.db.query("UPDATE users SET permissions='{}'::jsonb WHERE uid='author'");
    await noWrite(id, () => disabled('put', `/${id}/draft`, body), 403, 'permission_denied');
    await h.db.query('UPDATE users SET permissions=$1::jsonb WHERE uid=$2', [JSON.stringify({ editPages: true }), 'author']);

    // Every use, including later gallery items and the download-only ID, must
    // reject missing, cross-page and wrong-kind records. No mock associations.
    const uses = [value => find(value, 'image'), ...[0,1,2].map(index => value => find(value, 'gallery').items[index]),
      value => find(value, 'button').action, value => find(value, 'audio'), value => find(value, 'video')];
    for (const use of uses) for (const replacement of [randomUUID(), foreign.media_id, null]) {
      const invalid = structuredClone(document), ref = use(invalid);
      ref.media_id = replacement || (ref.kind === 'gif' || ['audio','video'].includes(ref.type) ? media.image.media_id : media.audio.media_id);
      await noWrite(id, () => h.api('put', `/${id}/draft`, { expected_version: saved.version, ...key(), document: invalid }), 400, 'media_not_ready');
    }
    // Download kind is itself checked, not merely the referenced record's existence.
    for (const [kind, extension] of [['gif','gif'], ['audio','mp3'], ['video','mp4']]) {
      const variant = structuredClone(document); find(variant, 'button').action = { type: 'download', kind, media_id: media[kind].media_id, file_name: `guia.${extension}` };
      const ack = status(await h.api('put', `/${id}/draft`, await saveBody(id, variant)), 200);
      assert.equal(await count('page_revision_media', 'WHERE revision_id=$1 AND media_id=$2', [ack.draft_revision_id, media[kind].media_id]), 1);
    }
    const invalidCues = structuredClone(document); find(invalidCues, 'video').captions[0].end_ms = media.video.duration_ms + 1;
    await noWrite(id, () => saveBody(id, invalidCues).then(input => h.api('put', `/${id}/draft`, input)), 400, 'invalid_media_cues');

    // SQL trigger failure must undo all projections, head and receipt, not only ACK.
    const failedBody = await saveBody(id, document);
    await h.db.exec("CREATE FUNCTION reject_v3_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic v3 audit failure'; END $$; CREATE TRIGGER reject_v3_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_v3_audit()");
    await noWrite(id, () => h.api('put', `/${id}/draft`, failedBody), 500);
    await h.db.exec('DROP TRIGGER reject_v3_audit ON audit_log; DROP FUNCTION reject_v3_audit()');
    const auditAck = status(await h.api('put', `/${id}/draft`, failedBody), 200);
    assert.equal(auditAck.version, failedBody.expected_version + 1);

    const ambiguousBody = await saveBody(id, document), beforeAmbiguous = await snapshot(id);
    await loseCommitAck(() => h.api('put', `/${id}/draft`, ambiguousBody));
    const committed = await ws(id);
    assert.equal(committed.version, ambiguousBody.expected_version + 1);
    const receipt = (await h.db.query('SELECT response FROM page_requests WHERE actor_uid=$1 AND client_mutation_id=$2', ['author', ambiguousBody.client_mutation_id])).rows[0].response;
    assert.deepEqual(status(await disabled('put', `/${id}/draft`, ambiguousBody), 200), receipt);
    assert.equal(await count('page_revisions'), beforeAmbiguous.revisions + 1);
    assert.equal(await count('audit_log'), beforeAmbiguous.audit + 1);
    const filesBefore = await readdir(join(h.directory, 'pages-private'));
    const mediaBefore = await count('page_media');
    await loseCommitAck(() => upload(id, 'image', asset.bytes, asset.file_name));
    assert.equal(await count('page_media'), mediaBefore + 1);
    const registered = (await h.db.query('SELECT id FROM page_media WHERE page_id=$1', [id])).rows;
    const ambiguousMedia = registered.find(row => !Object.values(media).some(item => item.media_id === row.id)).id;
    assert.equal((await readdir(join(h.directory, 'pages-private'))).length, filesBefore.length + 1, 'ambiguous commit must retain private bytes');
    status(await h.api('get', `/${id}/media/${ambiguousMedia}?preview=1`), 200);

    // Publication validates active audience even with the writer switched off.
    await h.db.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [cargoA]);
    await noWrite(id, () => publishBody(id).then(input => disabled('post', `/${id}/publish`, input, 'publisher')), 400, 'invalid_audience');
    await h.db.query('UPDATE job_titles SET active=TRUE WHERE id=$1', [cargoA]);
    const publishInput = await publishBody(id);
    await noWrite(id, () => disabled('post', `/${id}/publish`, publishInput), 403, 'permission_denied');
    const published = status(await disabled('post', `/${id}/publish`, publishInput, 'publisher'), 200);
    // Task 8: real attachment bytes, deterministic server filename and exact auth.
    for (const kind of ['image','gif','audio','video']) {
      const item = media[kind], path = `/${id}/media/${item.media_id}/download`;
      const response = await h.api('get', path, undefined, 'reader'); status(response, 200);
      const ext = { image: 'webp', gif: 'gif', audio: 'mp3', video: 'mp4' }[kind];
      assert.equal(response.headers['content-disposition'], `attachment; filename="material-${item.media_id}.${ext}"`);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-type'], item.mime_type);
      assert.equal(response.headers['accept-ranges'], undefined);
      const ranged = await h.request.get(`/api/pages${path}`).set('Authorization','Bearer reader').set('Range','bytes=0-1'); status(ranged, 200);
      assert.equal(ranged.headers['content-length'], response.headers['content-length']);
      for (const actor of ['outsider','publisher','super']) status(await h.api('get', path, undefined, actor), 404);
      status(await h.api('get', `${path}?preview=1`), 200);
      status(await h.api('get', `${path}?preview=1`, undefined, 'other'), 404);
      status(await h.api('get', `${path}?preview=1`, undefined, 'publisher'), 404);
      status(await h.api('get', `${path}?revision_id=${published.published_revision_id}`, undefined, 'publisher'), 200);
      status(await h.api('get', `${path}?revision_id=${published.published_revision_id}`, undefined, 'reader'), 403);
      status(await h.api('get', `/${legacy[1].id}/media/${item.media_id}/download?preview=1`), 404);
      status(await h.api('get', `${path}?revision_id=${randomUUID()}`, undefined, 'publisher'), 404);
      for (const query of ['file_name=evil.mp4','preview=0',`preview=1&revision_id=${published.published_revision_id}`, 'revision_id=bad']) status(await h.api('get', `${path}?${query}`), 400);
    }
    const downloadPath = `/${id}/media/${media.image.media_id}/download`;
    status(await h.api('get', `/${id}/media/${ambiguousMedia}/download`, undefined, 'reader'), 404);
    status(await h.api('get', `/${id}/media/${ambiguousMedia}/download?preview=1`), 200);
    const storageKey = (await h.db.query('SELECT storage_key FROM page_media WHERE id=$1', [media.image.media_id])).rows[0].storage_key;
    const storagePath = join(h.directory, 'pages-private', storageKey);
    // This harness does not mount /uploads. These HTTP denials establish its
    // public surface only; native Nginx isolation is a separate pending gate.
    for (const path of [`/uploads/pages-private/${storageKey}`, `/uploads/${storageKey}`, `/pages-private/${storageKey}`]) {
      const response = await h.request.get(path); status(response, 404);
      assert.equal(response.body?.media_id, undefined);
    }
    await rename(storagePath, `${storagePath}.test-held`);
    try { assert.equal(status(await h.api('get', downloadPath, undefined, 'reader'), 404).reason, 'media_unavailable'); }
    finally { await rename(`${storagePath}.test-held`, storagePath); }
    status(await h.request.get(`/api/pages${downloadPath}`), 401);
    assert.equal(status(await h.api('get', downloadPath, undefined, 'noethics'), 403).reason, 'ethics-required');
    assert.equal(status(await h.api('get', downloadPath, undefined, 'disabled'), 403).reason, 'account-disabled');
    const unverifiedDownload = await h.api('get', downloadPath, undefined, 'unverified');
    status(unverifiedDownload, 200);
    assert.ok(Buffer.isBuffer(unverifiedDownload.body), 'admitted unverified viewer receives actual published private bytes');
    assert.deepEqual(unverifiedDownload.body, status(await h.api('get', downloadPath, undefined, 'reader'), 200));
    assert.equal(unverifiedDownload.headers['cache-control'], 'private, no-store');
    status(await h.api('get', `${downloadPath}?revision_id=${published.published_revision_id}`, undefined, 'unverified'), 403);
    await h.db.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [cargoA]);
    status(await h.api('get', downloadPath, undefined, 'reader'), 404);
    status(await h.api('get', downloadPath, undefined, 'unverified'), 404);
    await h.db.query('UPDATE job_titles SET active=TRUE WHERE id=$1', [cargoA]);
    assert.deepEqual(status(await disabled('post', `/${id}/publish`, publishInput, 'publisher'), 200), published);
    await h.db.query("UPDATE users SET permissions='{}'::jsonb WHERE uid='publisher'");
    await noWrite(id, () => disabled('post', `/${id}/publish`, publishInput, 'publisher'), 403, 'permission_denied');
    await h.db.query('UPDATE users SET permissions=$1::jsonb WHERE uid=$2', [JSON.stringify({ publishPages: true }), 'publisher']);
    assert.deepEqual(status(await disabled('get', `/${id}`, undefined, 'reader'), 200).document, document);
    await h.db.query("UPDATE users SET job_title_id=NULL WHERE uid='super'");
    for (const actor of ['outsider','publisher','super']) status(await h.api('get', `/${id}`, undefined, actor), 404);
    for (const item of Object.values(media)) {
      const path = `/${id}/media/${item.media_id}`;
      const bytes = await disabled('get', path, undefined, 'reader'); status(bytes, 200);
      assert.match(bytes.headers['cache-control'], /private.*no-store/); assert.equal(bytes.headers['x-content-type-options'], 'nosniff');
      for (const actor of ['outsider','publisher','super']) status(await disabled('get', path, undefined, actor), 404);
    }
    status(await disabled('get', `/${id}/media/${ambiguousMedia}`, undefined, 'reader'), 404);
    await h.db.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [cargoA]);
    status(await disabled('get', `/${id}`, undefined, 'reader'), 404);
    status(await disabled('get', `/${id}/media/${media.gallery.media_id}`, undefined, 'reader'), 404);
    await h.db.query('UPDATE job_titles SET active=TRUE WHERE id=$1', [cargoA]);
    await h.db.query("UPDATE users SET job_title_id=NULL WHERE uid='reader'");
    status(await disabled('get', `/${id}`, undefined, 'reader'), 404);
    await h.db.query("UPDATE users SET job_title_id=$1 WHERE uid='reader'", [cargoA]);

    const next = structuredClone(document); next.metadata.title = 'Rascunho posterior'; next.metadata.category = 'Outra categoria';
    status(await h.api('put', `/${id}/draft`, await saveBody(id, next)), 200);
    status(await h.api('get', downloadPath, undefined, 'reader'), 200); // Draft does not change published access.
    assert.deepEqual(status(await disabled('get', `/${id}`, undefined, 'reader'), 200).document, document);
    assert.deepEqual((await h.db.query('SELECT document FROM page_revisions WHERE id=$1', [published.published_revision_id])).rows[0].document, document);
    // A newer publication removes normal access, not historical association/bytes.
    status(await h.api('put', `/${id}/draft`, await saveBody(id, placeholders)), 200);
    status(await h.api('get', `/${id}/media/${media.gallery.media_id}`, undefined, 'reader'), 200);
    const noMedia = structuredClone(document);
    for (const section of noMedia.sections) for (const row of section.rows) for (const column of row.columns) column.blocks = column.blocks.filter(block => !['image','gallery','audio','video','button'].includes(block.type));
    status(await h.api('put', `/${id}/draft`, await saveBody(id, noMedia)), 200);
    status(await disabled('post', `/${id}/publish`, await publishBody(id), 'publisher'), 200);
    status(await h.api('get', downloadPath, undefined, 'unverified'), 404);
    for (const item of Object.values(media)) {
      status(await disabled('get', `/${id}/media/${item.media_id}`, undefined, 'reader'), 404);
      status(await disabled('get', `/${id}/media/${item.media_id}/download`, undefined, 'reader'), 404);
      status(await disabled('get', `/${id}/media/${item.media_id}/download?revision_id=${published.published_revision_id}`, undefined, 'publisher'), 200);
      status(await disabled('get', `/${id}/media/${item.media_id}/download?revision_id=${published.published_revision_id}`), 200);
      status(await disabled('get', `/${id}/media/${item.media_id}?revision_id=${published.published_revision_id}`, undefined, 'publisher'), 200);
      status(await disabled('get', `/${id}/media/${item.media_id}?revision_id=${published.published_revision_id}`, undefined, 'reader'), 403);
    }
    assert.equal(await count('page_revision_media', 'WHERE revision_id=$1', [published.published_revision_id]), Object.keys(media).length);
    status(await disabled('post', `/${id}/archive`, { expected_version: (await ws(id)).version, ...key() }, 'publisher'), 200);
    status(await h.api('get', `${downloadPath}?revision_id=${published.published_revision_id}`, undefined, 'publisher'), 404);
    status(await disabled('get', `/${id}`, undefined, 'reader'), 404);
    status(await disabled('post', `/${id}/restore`, { expected_version: (await ws(id)).version, ...key() }, 'publisher'), 200);
    assert.equal((await ws(id)).published_revision_id, null);
    assert.equal((await ws(id)).draft.document.schema_version, 3);
    status(await disabled('get', `/${id}`, undefined, 'reader'), 404);

    // Quotas count registered historical files, even with zero current projections.
    // Use the other synthetic author for this independent scenario rather than
    // relaxing the real per-account write rate limiter during negative testing.
    const quotaPage = status(await disabled('post', '', { template_id: 'comunicado', ...key() }, 'other'), 201);
    const seed = status(await upload(quotaPage.id, 'image', asset.bytes, asset.file_name, 'other'), 201);
    await h.db.query(`INSERT INTO page_media SELECT (jsonb_populate_record(NULL::page_media,
      to_jsonb(m) || jsonb_build_object('id',gen_random_uuid(),'storage_key','pages-' || gen_random_uuid() || '.webp'))).*
      FROM page_media m CROSS JOIN generate_series(1,49) WHERE m.id=$1`, [seed.media_id]);
    assert.equal(await count('page_revision_media', 'WHERE page_id=$1', [quotaPage.id]), 0);
    const quotaFiles = (await readdir(join(h.directory, 'pages-private'))).sort();
    await noWrite(quotaPage.id, () => upload(quotaPage.id, 'image', asset.bytes, asset.file_name, 'other'), 413, 'page_media_quota');
    assert.deepEqual((await readdir(join(h.directory, 'pages-private'))).sort(), quotaFiles, 'rejected count quota compensates only its own new bytes');
    const bytesPage = status(await disabled('post', '', { template_id: 'comunicado', ...key() }, 'other'), 201);
    await h.db.query(`INSERT INTO page_media SELECT (jsonb_populate_record(NULL::page_media,
      to_jsonb(m) || jsonb_build_object('id',gen_random_uuid(),'page_id',$2::uuid,
        'storage_key','pages-' || gen_random_uuid() || '.mp4','byte_size',26214400))).*
      FROM page_media m CROSS JOIN generate_series(1,4) WHERE m.id=$1`, [media.video.media_id, bytesPage.id]);
    await noWrite(bytesPage.id, () => upload(bytesPage.id, 'image', asset.bytes, asset.file_name, 'other'), 413, 'page_media_quota');
    assert.deepEqual((await readdir(join(h.directory, 'pages-private'))).sort(), quotaFiles, 'rejected historical byte quota retains all old bytes');
    assert.ok(h.tokenChecks.every(check => check.checkRevoked === true));
    console.log(`Pages v3 database PASS: ${assertions} HTTP checks; real upload/projections for image/gallery/GIF/audio/video/download, authorized flag-off replay, default-disabled writes, downgrade/CAS, revoked capabilities/accounts/audience, audit rollback, committed ambiguous ACK, history/quotas. PGlite serialized; Firebase synthetic; native PostgreSQL 16 gates PENDING.`);
  } finally { await h?.close(); await fixtures.close(); }
}

async function checkPagesAliasesDatabase() {
  const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
  let assertions = 0;
  const status = (response, expected) => { assert.equal(response.status, expected, JSON.stringify(response.body)); assertions++; return response.body; };
  const ws = async (id, actor = 'author') => status(await h.api('get', `/${id}/workspace`, undefined, actor), 200);
  const create = async (actor = 'author', body = { template_id: 'comunicado', ...key() }) => status(await h.api('post', '', body, actor), 201);
  // Explicit synthetic fixtures for pre-alias rows; no runtime backfill or rename API.
  const legacy = async (actor = 'author') => { const ack = await create(actor); await h.db.query('UPDATE pages SET slug=NULL WHERE id=$1', [ack.id]); return ack.id; };
  const doc = (title, category = '') => { const document = upgradeDocument(pageDocument(title)); document.metadata.category = category; return document; };
  const saveInput = async (id, document, actor = 'author') => ({ expected_version: (await ws(id, actor)).version, ...key(), document });
  const save = async (id, document, actor = 'author') => status(await h.api('put', `/${id}/draft`, await saveInput(id, document, actor), actor), 200);
  const snapshot = async () => {
    const result = {};
    for (const table of ['pages', 'page_revisions', 'page_revision_job_titles', 'page_revision_media', 'page_requests', 'audit_log']) result[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  };
  const noWrite = async (action, expected, reason) => { const before = await snapshot(); const response = status(await action(), expected); if (reason) assert.equal(response.reason, reason); assert.deepEqual(await snapshot(), before); };
  try {
    const createBody = { template_id: 'comunicado', ...key() };
    const first = await create('author', createBody), second = await create();
    assert.equal(first.slug, 'exemplo-de-comunicado-vestimenta-no-trabalho');
    assert.equal(second.slug, `${first.slug}-${second.id.replaceAll('-', '')}`);
    assert.equal((await ws(first.id)).slug, first.slug);
    await save(first.id, doc('Renomeado sem mudar alias'));
    const beforeReplay = await snapshot();
    assert.deepEqual(status(await h.api('post', '', createBody), 201), first);
    assert.deepEqual(await snapshot(), beforeReplay);

    const id = await legacy(), otherId = await legacy();
    assert.equal((await ws(id)).slug, null);
    const blank = await save(id, doc('  ')); assert.equal(blank.slug, null);
    const input = await saveInput(id, doc('Código de vestimenta', 'Pessoas'));
    h.app.use('/api/pages-alias-disabled', createPagesRouter({ pool: h.pool, authenticate: h.authenticate, uploadDirectory: h.directory, v3WritesEnabled: false }));
    await noWrite(() => h.request.put(`/api/pages-alias-disabled/${id}/draft`).set('Authorization', 'Bearer author').send(input), 409, 'document_version_disabled');
    await h.db.exec("CREATE FUNCTION reject_alias_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic alias audit failure'; END $$; CREATE TRIGGER reject_alias_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_alias_audit()");
    await noWrite(() => h.api('put', `/${id}/draft`, input), 500);
    await h.db.exec('DROP TRIGGER reject_alias_audit ON audit_log; DROP FUNCTION reject_alias_audit()');
    const saved = status(await h.api('put', `/${id}/draft`, input), 200);
    assert.equal(saved.slug, 'codigo-de-vestimenta');
    const duplicate = await save(otherId, doc('Código de vestimenta', 'Pessoas'));
    assert.equal(duplicate.slug, `${saved.slug}-${otherId.replaceAll('-', '')}`);
    await save(id, doc('Novo título', 'Cultura'));
    assert.equal((await ws(id)).slug, saved.slug);
    const renamed = await snapshot();
    assert.deepEqual(status(await h.api('put', `/${id}/draft`, input), 200), saved);
    assert.deepEqual(await snapshot(), renamed, 'replay after rename neither reserves nor revises');
    await noWrite(() => h.api('put', `/${id}/draft`, input, 'other'), 403, 'author_only');

    // A different normalized title can own this page's deterministic fallback.
    const collision = await legacy(), owner = await legacy();
    const occupied = `${saved.slug}-${collision.replaceAll('-', '')}`;
    await save(owner, doc(occupied, 'Privacidade'));
    await noWrite(() => saveInput(collision, doc('Código de vestimenta')).then(body => h.api('put', `/${collision}/draft`, body)), 409, 'slug_conflict');
    assert.equal((await ws(collision)).slug, null);

    // Deterministic injection of the last-defense UNIQUE race, not concurrency:
    // real SQL inserts a competitor between candidate SELECT and the UPDATE.
    const racing = await legacy(), competitor = randomUUID();
    await h.db.exec(`CREATE FUNCTION compete_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${racing}'::uuid THEN INSERT INTO pages(id,author_uid,slug) VALUES('${competitor}','other',NEW.slug); END IF;
      RETURN NEW; END $$; CREATE TRIGGER compete_alias BEFORE UPDATE OF slug ON pages FOR EACH ROW EXECUTE FUNCTION compete_alias()`);
    const racingInput = await saveInput(racing, doc('Reserva concorrente sintética'));
    await noWrite(() => h.api('put', `/${racing}/draft`, racingInput), 409, 'slug_conflict');
    await h.db.exec('DROP TRIGGER compete_alias ON pages; DROP FUNCTION compete_alias()');
    status(await h.api('put', `/${racing}/draft`, racingInput), 200);

    const slugPath = `/by-slug/${saved.slug}`;
    for (const path of ['/categories', slugPath, '/by-slug/INVALID']) {
      status(await h.request.get(`/api/pages${path}`), 401);
      assert.equal(status(await h.api('get', path, undefined, 'noethics'), 403).reason, 'ethics-required');
      assert.equal(status(await h.api('get', path, undefined, 'disabled'), 403).reason, 'account-disabled');
    }
    // Email verification no longer gates admitted accounts. This viewer still
    // lacks category-management capabilities and cannot read an unpublished alias.
    assert.equal(status(await h.api('get', '/categories', undefined, 'unverified'), 403).reason, 'permission_denied');
    assert.equal(status(await h.api('get', slugPath, undefined, 'unverified'), 404).reason, 'not_visible');
    assert.equal(status(await h.api('get', '/by-slug/INVALID', undefined, 'unverified'), 400).reason, 'invalid_slug');
    const hidden = status(await h.api('get', slugPath, undefined, 'reader'), 404);
    assert.equal(hidden.reason, 'not_visible');
    for (const slug of ['UPPER', 'a--b', '-a', 'a-', 'á', 'a'.repeat(121), 'a%2Fb', 'a%0A']) status(await h.api('get', `/by-slug/${slug}`, undefined, 'reader'), 400);
    const current = await ws(id);
    status(await h.api('post', `/${id}/publish`, { expected_version: current.version, revision_id: current.draft_revision_id, ...key() }, 'publisher'), 200);
    const read = await h.api('get', slugPath, undefined, 'reader'); status(read, 200);
    assert.match(read.headers['cache-control'], /private.*no-store/);
    assert.deepEqual(read.body, status(await h.api('get', `/${id}`, undefined, 'reader'), 200));
    assert.deepEqual(status(await h.api('get', slugPath, undefined, 'unverified'), 200), read.body);
    assert.equal(read.body.slug, saved.slug);
    await h.db.query("UPDATE users SET job_title_id=NULL WHERE uid='super'");
    for (const actor of ['outsider','publisher','super']) {
      const response = status(await h.api('get', slugPath, undefined, actor), 404);
      assert.equal(response.reason, hidden.reason);
    }
    await h.db.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [cargoA]);
    status(await h.api('get', slugPath, undefined, 'reader'), 404);
    status(await h.api('get', slugPath, undefined, 'unverified'), 404);
    await h.db.query('UPDATE job_titles SET active=TRUE WHERE id=$1', [cargoA]);
    await h.db.query("UPDATE users SET job_title_id=NULL WHERE uid='reader'");
    status(await h.api('get', slugPath, undefined, 'reader'), 404);
    await h.db.query("UPDATE users SET job_title_id=$1 WHERE uid='reader'", [cargoA]);
    const newDraft = doc('Título posterior à publicação', 'Cultura');
    await save(id, newDraft);
    assert.deepEqual(status(await h.api('get', slugPath, undefined, 'reader'), 200).document, read.body.document);
    assert.deepEqual(status(await h.api('get', slugPath, undefined, 'unverified'), 200).document, read.body.document);
    const catalog = status(await h.api('get', '', undefined, 'reader'), 200);
    assert.equal(catalog.find(page => page.id === id).title, read.body.document.metadata.title, 'catalog exposes published title, never newer draft');
    assert.equal(status(await h.api('get', '', undefined, 'outsider'), 200).some(page => page.id === id), false);
    status(await h.api('get', '/by-slug/inexistente', undefined, 'reader'), 404);
    assert.equal((await ws(first.id)).slug, first.slug, 'reads do not rename any alias');

    const foreignId = await legacy('other');
    await save(foreignId, doc('Outra autoria', 'Categoria secreta'), 'other');
    for (const actor of ['author','reader','outsider']) assert.equal(status(await h.api('get', '', undefined, actor), 200).some(page => page.id === foreignId), false, 'foreign unpublished draft absent from normal catalog');
    const query = async (search, actor = 'author') => { const response = await h.api('get', `/categories${search}`, undefined, actor); status(response, 200); assert.match(response.headers['cache-control'], /private.*no-store/); return response; };
    assert.deepEqual((await query('')).body, ['Cultura', 'Pessoas', 'Privacidade']);
    assert.deepEqual((await query('', 'other')).body, ['Categoria secreta']);
    assert.deepEqual((await query('', 'publisher')).body, ['Categoria secreta', 'Cultura', 'Pessoas', 'Privacidade']);
    assert.deepEqual((await query('', 'super')).body, ['Categoria secreta', 'Cultura', 'Pessoas', 'Privacidade']);
    const paged = await query('?limit=1&offset=1'); assert.deepEqual(paged.body, ['Pessoas']); assert.equal(paged.headers['x-total-count'], '3');
    const empty = await query('?limit=1&offset=100'); assert.deepEqual(empty.body, []); assert.equal(empty.headers['x-total-count'], '3');
    assert.deepEqual((await query('?q=cULT')).body, ['Cultura']);
    assert.deepEqual((await query(`?q=${encodeURIComponent("' OR TRUE --")}`)).body, []);
    for (const actor of ['reader','outsider','forged']) status(await h.api('get', '/categories', undefined, actor), 403);
    for (const search of [`?q=${'a'.repeat(81)}`, '?q=a&q=b', '?limit=0', '?offset=-1', '?unknown=1', '?tag=a']) status(await h.api('get', `/categories${search}`), 400);
    status(await h.api('get', `/categories?q=${'a'.repeat(80)}`), 200);
    await noWrite(() => saveInput(otherId, doc('Título válido', 'a'.repeat(81))).then(body => h.api('put', `/${otherId}/draft`, body)), 400);
    await save(otherId, doc('Categoria livre', 'a'.repeat(80)));
    assert.deepEqual((await query(`?q=${'a'.repeat(80)}`)).body, ['a'.repeat(80)], 'free category selection up to 80 chars, no catalog membership');

    status(await h.api('post', `/${id}/archive`, { expected_version: (await ws(id)).version, ...key() }, 'publisher'), 200);
    status(await h.api('get', slugPath, undefined, 'reader'), 404);
    assert.equal((await ws(id)).slug, saved.slug);
    assert.deepEqual((await query('?q=Cultura')).body, [], 'archived drafts excluded');
    status(await h.api('post', `/${id}/restore`, { expected_version: (await ws(id)).version, ...key() }, 'publisher'), 200);
    status(await h.api('get', slugPath, undefined, 'reader'), 404);
    // Publisher-only review never reserves an alias for a legacy row.
    const reviewOnly = await legacy();
    assert.equal(status(await h.api('get', `/${reviewOnly}/workspace`, undefined, 'publisher'), 200).slug, null);
    status(await h.api('get', `/${reviewOnly}/preview`, undefined, 'publisher'), 200);
    assert.equal((await ws(reviewOnly)).slug, null);
    const downgrading = await legacy();
    const head = doc('V3 sem alias legado');
    await save(downgrading, head);
    await h.db.query('UPDATE pages SET slug=NULL WHERE id=$1', [downgrading]);
    await noWrite(() => saveInput(downgrading, pageDocument('Título de downgrade')).then(body => h.api('put', `/${downgrading}/draft`, body)), 409, 'schema_downgrade_conflict');
    assert.equal((await ws(downgrading)).slug, null);
    const oldAck = { id: reviewOnly, version: 0, draft_revision_id: (await ws(reviewOnly)).draft_revision_id, published_revision_id: null };
    const receiptKey = key();
    const { hash } = require('./pages/store');
    const replayBody = { template_id: 'comunicado', ...receiptKey };
    await h.db.query(`INSERT INTO page_requests(actor_uid,client_mutation_id,operation,target_id,request_hash,response,status)
      VALUES('author',$1,'create',$2,$3,$4::jsonb,201)`, [receiptKey.client_mutation_id, reviewOnly, hash({ operation: 'create', targetId: null, payload: replayBody }), JSON.stringify(oldAck)]);
    const oldBefore = await snapshot();
    assert.deepEqual(status(await h.api('post', '', replayBody), 201), oldAck);
    assert.deepEqual(await snapshot(), oldBefore, 'legacy receipt without slug is replayed unchanged');
    console.log(`Pages aliases/categories database PASS: ${assertions} HTTP checks; stable create/draft aliases, deterministic collision/UNIQUE rollback, audit rollback, replay after rename/legacy ACK, same-query authenticated audience, restricted DISTINCT categories/pagination. PGlite serialized; UNIQUE race injected, not concurrent; native PostgreSQL 16 two-connection tests PENDING.`);
  } finally { await h.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPagesV3Database();
