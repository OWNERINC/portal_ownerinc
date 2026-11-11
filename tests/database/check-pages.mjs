// Real Pages routes, SQL and private files in an ephemeral PostgreSQL WASM DB.
// Only Firebase token verification is replaced. Never connects to an existing DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const supertest = require('supertest');
const sharp = require('sharp');
const security = require('./middleware/security');
const { acceptTerm, term } = require('./ethics');
export const cargoA = '10000000-0000-4000-8000-000000000001';
export const cargoB = '10000000-0000-4000-8000-000000000002';

export function pageDocument(title = 'Comunicado sintético', jobTitleIds = [cargoA]) {
  return {
    schema_version: 1,
    template: { id: 'comunicado', version: 1 },
    metadata: { title, summary: 'Documento de teste, não uma política oficial.', tags: ['sintético'], audience: { type: 'job_titles', job_title_ids: jobTitleIds } },
    presentation: { theme: 'conecta', font: 'manrope', text_scale: 'standard' },
    sections: [{ id: randomUUID(), label: 'Comunicado', rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [{
      id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto sintético para verificar rascunho, publicação e audiência.' }] }] },
    }] }] }] }],
  };
}

export async function createPagesDatabaseHarness({ afterFoundation } = {}) {
  if (!process.env.PGLITE_MODULE_PATH) throw new Error('Set PGLITE_MODULE_PATH to external @electric-sql/pglite; no existing database is accepted');
  const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
  const db = new PGlite();
  const directory = await mkdtemp(join(tmpdir(), 'opencode', 'pages-test-'));
  const statements = [];
  let tail = Promise.resolve();
  async function acquire() {
    const previous = tail;
    let release;
    tail = new Promise(done => { release = done; });
    await previous;
    return release;
  }
  async function query(sql, parameters = []) {
    statements.push(String(sql));
    assert.doesNotMatch(String(sql), /cms_documents|cms_revisions|cms_assets|owner_news_|7193029/i, 'Pages accessed historical editorial storage');
    const result = await db.query(sql, parameters);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }
  const pool = {
    async query(...args) { const release = await acquire(); try { return await query(...args); } finally { release(); } },
    async connect() {
      const release = await acquire();
      let released = false;
      return { query, release() { if (!released) { released = true; release(); } } };
    },
  };
  let server;
  try {
    await db.exec(`CREATE ROLE portal_api; CREATE ROLE portal_cron;
      CREATE TABLE job_titles (id UUID PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, page_access JSONB NOT NULL DEFAULT '{}');
      CREATE TABLE users (uid TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, permissions JSONB NOT NULL DEFAULT '{}', job_title_id UUID REFERENCES job_titles(id), firebase_enable_pending BOOLEAN NOT NULL DEFAULT FALSE);
      CREATE TABLE pending_registrations (firebase_uid TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_uid TEXT REFERENCES users(uid) ON DELETE SET NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, request_id TEXT, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    await db.query('INSERT INTO job_titles (id,name) VALUES ($1,$2),($3,$4)', [cargoA, 'Cargo sintético A', cargoB, 'Cargo sintético B']);
    const actors = [
      ['author', 'admin', { editPages: true }, cargoA],
      ['other', 'admin', { editPages: true }, cargoA],
      ['publisher', 'admin', { publishPages: true }, cargoB],
      ['super', 'admin', { superAdmin: true }, cargoB],
      ['reader', 'viewer', {}, cargoA],
      ['outsider', 'viewer', {}, cargoB],
      ['forged', 'viewer', { editPages: true, publishPages: true }, cargoA],
      ['noethics', 'viewer', {}, cargoA],
      ['disabled', 'admin', { editPages: true, accountDisabled: true }, cargoA],
      ['unverified', 'viewer', {}, cargoA],
    ];
    for (const [uid, role, permissions, job] of actors) {
      await db.query('INSERT INTO users(uid,name,email,role,permissions,job_title_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [uid, `Conta sintética ${uid}`, `${uid}@example.test`, role, JSON.stringify(permissions), job]);
    }
    const migration = await readFile(new URL('../../api/db/migrations/040_pages.sql', import.meta.url), 'utf8');
    await db.exec(await readFile(new URL('../../api/db/migrations/039_ethics_acceptances.sql', import.meta.url), 'utf8'));
    await db.exec(migration);
    await db.exec(migration);
    // Upgrade a populated first-lote database without changing its old snapshots.
    if (afterFoundation) await afterFoundation(db);
    const expansion = await readFile(new URL('../../api/db/migrations/041_pages_media.sql', import.meta.url), 'utf8');
    await db.exec(expansion);
    await db.exec(expansion);
    for (const [uid] of actors) if (uid !== 'noethics') await acceptTerm(db, uid);
    await db.exec('GRANT SELECT, UPDATE ON users, job_titles TO portal_api; GRANT SELECT ON pending_registrations TO portal_api; GRANT SELECT, INSERT ON audit_log TO portal_api');
    const authFile = fileURLToPath(new URL('../../api/middleware/auth.js', import.meta.url));
    const localRequire = createRequire(authFile);
    const authModule = { exports: {} };
    const tokenChecks = [];
    const dependencies = new Map([
      ['../db', pool],
      ['firebase-admin/app', { getApps: () => [{}] }],
      ['firebase-admin/auth', { getAuth: () => ({ async verifyIdToken(token, checkRevoked) {
        tokenChecks.push({ token, checkRevoked });
        if (!actors.some(([uid]) => uid === token)) throw new Error('Unknown synthetic identity');
        return { uid: token, email_verified: token !== 'unverified' };
      } }) }],
    ]);
    new Function('require', 'module', 'exports', await readFile(authFile, 'utf8'))(name => dependencies.has(name) ? dependencies.get(name) : localRequire(name), authModule, authModule.exports);
    const { authMiddleware } = authModule.exports;
    const { createPagesRouter } = require('./pages/router');
    const app = express();
    app.use(security.requestContext);
    app.use(security.safeResponses);
    app.use(express.json({ limit: '1mb' }));
    app.get('/api/users/me', authMiddleware, (req, res) => res.json(req.user));
    app.get('/api/ethics', authMiddleware, (req, res) => res.json({ term, accepted: req.user.ethics_accepted === true }));
    app.use('/api/pages', createPagesRouter({ pool, authenticate: authMiddleware, uploadDirectory: directory }));
    app.use(security.errorHandler);
    server = createServer(app);
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = supertest(origin);
    async function api(method, path, body, actor = 'author') {
      const call = request[method](`/api/pages${path}`).set('Authorization', `Bearer ${actor}`);
      return body === undefined ? await call : await call.send(body);
    }
    async function close() {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      await db.close();
      // This test owns this exact mkdtemp directory, never an existing upload dir.
      await rm(directory, { recursive: true, force: true });
    }
    return { db, app, pool, request, api, directory, origin, statements, tokenChecks, close };
  } catch (error) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(done => server.close(done));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function checkPagesDatabase() {
  const h = await createPagesDatabaseHarness();
  let assertions = 0;
  const expectStatus = (response, status) => { assert.equal(response.status, status, JSON.stringify(response.body)); assertions++; return response.body; };
  const mutation = () => ({ client_mutation_id: randomUUID() });
  const workspace = async id => expectStatus(await h.api('get', `/${id}/workspace`), 200);
  try {
    expectStatus(await h.request.get('/api/pages'), 401);
    expectStatus(await h.api('get', '', undefined, 'noethics'), 403);
    expectStatus(await h.api('get', '', undefined, 'disabled'), 403);
    expectStatus(await h.api('get', '', undefined, 'unverified'), 403);
    for (const actor of ['reader', 'forged', 'publisher']) expectStatus(await h.api('post', '', { template_id: 'comunicado', ...mutation() }, actor), 403);
    const createInput = { template_id: 'comunicado', ...mutation() };
    const auditBeforeCreate = (await h.db.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count;
    const createResponses = await Promise.all([h.api('post', '', createInput), h.api('post', '', createInput)]);
    const created = expectStatus(createResponses[0], 201);
    assert.ok(created.id);
    const id = created.id;
    const duplicate = createResponses[1];
    assert.ok([200, 201].includes(duplicate.status));
    assert.equal(duplicate.body.id, id);
    assert.equal((await h.db.query('SELECT count(*)::int AS count FROM pages')).rows[0].count, 1);
    assert.equal((await h.db.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count, auditBeforeCreate + 1, 'replayed create must not duplicate audit');
    expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 404);
    for (const actor of ['other', 'reader', 'forged']) expectStatus(await h.api('get', `/${id}/workspace`, undefined, actor), 403);
    expectStatus(await h.api('get', `/${id}/workspace`, undefined, 'publisher'), 200);
    let current = await workspace(id);
    expectStatus(await h.api('post', `/${id}/publish`, { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id }, 'publisher'), 400);
    const document = pageDocument();
    const saveInput = { ...mutation(), expected_version: current.version, document };
    expectStatus(await h.api('put', `/${id}/draft`, saveInput), 200);
    expectStatus(await h.api('put', `/${id}/draft`, saveInput), 200);
    expectStatus(await h.api('put', `/${id}/draft`, { ...saveInput, document: pageDocument('Outra fotografia') }), 409);
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document }), 409);
    current = await workspace(id);
    for (const actor of ['other', 'publisher', 'super', 'forged']) expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document }, actor), 403);
    expectStatus(await h.api('post', `/${id}/publish`, { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id }), 403);
    const publishInput = { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id };
    const auditBeforePublish = (await h.db.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count;
    expectStatus(await h.api('post', `/${id}/publish`, publishInput, 'publisher'), 200);
    expectStatus(await h.api('post', `/${id}/publish`, publishInput, 'publisher'), 200);
    assert.equal((await h.db.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count, auditBeforePublish + 1, 'replayed publish must not duplicate audit');
    const published = expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 200);
    assert.equal(published.document.metadata.title, document.metadata.title);
    expectStatus(await h.api('get', `/${id}`, undefined, 'outsider'), 404);
    expectStatus(await h.api('get', `/${id}`, undefined, 'publisher'), 404);
    const hiddenCatalog = expectStatus(await h.api('get', '', undefined, 'outsider'), 200);
    assert.equal(hiddenCatalog.length, 0);
    current = await workspace(id);
    const nextDocument = pageDocument('Novo rascunho restrito ao cargo B', [cargoB]);
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: nextDocument }), 200);
    assert.equal(expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 200).document.metadata.title, document.metadata.title);
    expectStatus(await h.api('get', `/${id}`, undefined, 'outsider'), 404);
    expectStatus(await h.api('post', `/${id}/publish`, { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id }, 'publisher'), 409);
    current = await workspace(id);
    const unsafe = structuredClone(nextDocument);
    unsafe.sections[0].rows[0].columns[0].blocks[0].content.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: unsafe }), 400);
    for (const href of ['//external.example.test/private', '/\\external.example.test/private', 'https://account:password@example.test/', 'data:text/html,unsafe']) {
      const invalidLink = structuredClone(nextDocument);
      invalidLink.sections[0].rows[0].columns[0].blocks[0].content.content[0].content[0].marks = [{ type: 'link', attrs: { href } }];
      expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: invalidLink }), 400);
    }
    const invalidIds = structuredClone(nextDocument);
    invalidIds.sections[0].rows[0].columns[0].blocks[0].id = invalidIds.sections[0].id;
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: invalidIds }), 400);
    // Audit failure must roll back the revision, request receipt and page version.
    await h.db.exec("CREATE FUNCTION reject_page_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_page_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_page_audit()");
    const failedInput = { ...mutation(), expected_version: current.version, document: pageDocument('Não pode persistir') };
    expectStatus(await h.api('put', `/${id}/draft`, failedInput), 500);
    assert.equal((await workspace(id)).version, current.version);
    await h.db.exec('DROP TRIGGER reject_page_audit ON audit_log; DROP FUNCTION reject_page_audit()');
    expectStatus(await h.api('put', `/${id}/draft`, failedInput), 200);
    current = await workspace(id);
    // A real decoded and normalized image follows the same authorization policy.
    const png = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#2A275E' } }).png().toBuffer();
    const upload = expectStatus(await h.request.post(`/api/pages/${id}/media`).set('Authorization', 'Bearer author').field('client_mutation_id', randomUUID()).attach('image', png, 'synthetic.png'), 201);
    const mediaId = upload.id || upload.media_id;
    assert.ok(mediaId, 'upload must return a stable media id');
    expectStatus(await h.api('get', `/${id}/media/${mediaId}`, undefined, 'reader'), 404);
    expectStatus(await h.request.get(`/api/pages/${id}/media/${mediaId}`), 401);
    expectStatus(await h.request.post(`/api/pages/${id}/media`).set('Authorization', 'Bearer other').attach('image', png, 'synthetic.png'), 403);
    const withImage = pageDocument('Publicação com imagem privada');
    withImage.sections[0].rows.push({ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [{ id: randomUUID(), type: 'image', media_id: mediaId, alt: 'Imagem sintética para teste', caption: '', credit: '' }] }] });
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: withImage }), 200);
    current = await workspace(id);
    expectStatus(await h.api('post', `/${id}/publish`, { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id }, 'publisher'), 200);
    const image = await h.api('get', `/${id}/media/${mediaId}`, undefined, 'reader');
    expectStatus(image, 200);
    assert.match(image.headers['content-type'], /image\/webp/);
    assert.match(image.headers['cache-control'], /private.*no-store/);
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    expectStatus(await h.api('get', `/${id}/media/${mediaId}`, undefined, 'outsider'), 404);
    // Replacing a published document removes normal access to its historical image.
    current = await workspace(id);
    expectStatus(await h.api('put', `/${id}/draft`, { ...mutation(), expected_version: current.version, document: pageDocument('Publicação sem imagem') }), 200);
    const imageRevision = current.published_revision_id;
    current = await workspace(id);
    expectStatus(await h.api('post', `/${id}/publish`, { ...mutation(), expected_version: current.version, revision_id: current.draft_revision_id }, 'publisher'), 200);
    expectStatus(await h.api('get', `/${id}/media/${mediaId}`, undefined, 'reader'), 404);
    expectStatus(await h.api('get', `/${id}/media/${mediaId}?revision_id=${imageRevision}`, undefined, 'reader'), 403);
    await h.db.query('UPDATE job_titles SET active = FALSE WHERE id = $1', [cargoA]);
    expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 404);
    expectStatus(await h.api('get', `/${id}/media/${mediaId}`, undefined, 'reader'), 404);
    await h.db.query('UPDATE job_titles SET active = TRUE WHERE id = $1', [cargoA]);
    current = await workspace(id);
    expectStatus(await h.api('post', `/${id}/archive`, { ...mutation(), expected_version: current.version }, 'publisher'), 200);
    expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 404);
    current = await workspace(id);
    expectStatus(await h.api('post', `/${id}/restore`, { ...mutation(), expected_version: current.version }, 'publisher'), 200);
    expectStatus(await h.api('get', `/${id}`, undefined, 'reader'), 404);
    assert.equal((await workspace(id)).published_revision_id, null, 'restore must not republish');
    assert.ok((await readdir(join(h.directory, 'pages-private'))).length, 'historical image bytes retained');
    const grants = await h.db.query("SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'portal_api' AND table_name LIKE 'page%'");
    for (const table of ['page_revisions', 'page_revision_job_titles', 'page_revision_media']) {
      const privileges = grants.rows.filter(row => row.table_name === table).map(row => row.privilege_type);
      assert.ok(privileges.includes('INSERT') && privileges.includes('SELECT'), table);
      assert.ok(!privileges.includes('UPDATE') && !privileges.includes('DELETE'), `${table}: snapshot references must be append-only`);
    }
    await h.db.exec('SET ROLE portal_api');
    const runtimePage = expectStatus(await h.api('post', '', { template_id: 'comunicado', ...mutation() }, 'other'), 201);
    const runtimeWorkspace = expectStatus(await h.api('get', `/${runtimePage.id}/workspace`, undefined, 'other'), 200);
    expectStatus(await h.api('put', `/${runtimePage.id}/draft`, { ...mutation(), expected_version: runtimeWorkspace.version, document: pageDocument('Escrita sob papel runtime') }, 'other'), 200);
    for (const table of ['page_revisions', 'page_revision_job_titles', 'page_revision_media']) {
      await assert.rejects(h.db.query(`DELETE FROM ${table} WHERE FALSE`), /permission denied/, `${table}: runtime delete denied`);
    }
    await assert.rejects(h.db.query('UPDATE page_revisions SET title = title WHERE FALSE'), /permission denied/);
    await h.db.exec('RESET ROLE');
    await h.db.exec('SET ROLE portal_cron');
    await assert.rejects(h.db.query('SELECT * FROM pages'), /permission denied/);
    await h.db.exec('RESET ROLE');
    await h.db.query('DELETE FROM users WHERE uid = $1', ['author']);
    assert.equal((await h.db.query('SELECT author_uid FROM pages WHERE id = $1', [id])).rows[0].author_uid, null);
    expectStatus(await h.api('get', `/${id}/workspace`, undefined, 'publisher'), 200);
    assert.ok(h.tokenChecks.every(check => check.checkRevoked === true));
    console.log(`Pages integration PASS: ${assertions} HTTP assertions; real migration/SQL, normalized private image, audit rollback, CAS, idempotency and ethics; PostgreSQL WASM, synthetic Firebase only.`);
  } finally { await h.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkPagesDatabase();
