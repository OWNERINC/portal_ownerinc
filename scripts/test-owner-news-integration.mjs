import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { cmsApp } from '../tests/helpers/cms-app.mjs';
import { ownerNewsApp } from '../tests/helpers/owner-news-app.mjs';
import { checkBundleImport } from '../tests/helpers/owner-news-bundle-integration.mjs';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (process.env.NODE_ENV === 'production') throw new Error('Owner News integration cannot run with NODE_ENV=production');
if (process.env.MIGRATION_TEST_DISPOSABLE !== 'true') throw new Error('MIGRATION_TEST_DISPOSABLE=true is required');
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');
const { getPublishedAnnouncement, listPublishedAnnouncements, promoteDueScheduledForPool, validatePublishedBlocksBatch } = require('../api/cms/reader');
const { lockCmsAssets } = require('../api/cms/locks');
const { canManageCms } = require('../api/cms/permissions');
const { getAuthority } = require('../api/owner-news/authority');
const { createPollDraft, publishPoll, closePoll, readPoll, readCurrentPoll, voteOnPoll } = require('../api/owner-news/polls');
const supertest = require('supertest');
await migrate();
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
const documentIds = [];
const assetIds = [];
const uid = `owner-news-fixture-${randomUUID()}`;
const oldEditorial = { version: 1, kind: 'article', summary: 'Publicada', author: 'Autora A', source_label: '', source_date: null };
const newEditorial = { ...oldEditorial, summary: 'Rascunho', author: 'Autora B' };
const blocks = [{ type: 'paragraph', text: 'Texto de trabalho.' }];
const request = supertest(cmsApp(pool, { uid, role: 'admin', permissions: { manageKnowledge: true } }));
let homeSnapshot;
const pollIds = [];
const voterUid = `owner-news-voter-${randomUUID()}`;
const pollUserIds = [];
async function withTransaction(callback, { rollback = false } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await callback(db);
    await db.query(rollback ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
async function checkPollSchema() {
  const columns = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='owner_news_poll_votes'`);
  assert.deepEqual(columns.rows.map(row => row.column_name).sort(), ['created_at', 'option_id', 'poll_id', 'user_uid']);
  await client.query('INSERT INTO users (uid, email, name) VALUES ($1, $2, $3)',
    [voterUid, `${voterUid}@example.com`, 'Votante sintético P1']);
  for (let i = 0; i < 2; i += 1) {
    const { rows: [poll] } = await client.query(`INSERT INTO owner_news_polls
      (title, question, created_by, updated_by) VALUES ('Fixture P1', 'Pergunta sintética?', $1, $1)
      RETURNING id, status, version`, [voterUid]);
    pollIds.push(poll.id);
    assert.equal(poll.status, 'draft');
    assert.equal(poll.version, 1);
  }
  const [pollId, otherPollId] = pollIds;
  const { rows: options } = await client.query(`INSERT INTO owner_news_poll_options (poll_id, label, position)
    VALUES ($1, 'Opção A', 0), ($1, 'Opção B', 1), ($2, 'Outra opção', 0) RETURNING id, poll_id, position`, [pollId, otherPollId]);
  const optionId = options.find(row => row.poll_id === pollId && row.position === 0).id;
  const secondOptionId = options.find(row => row.poll_id === pollId && row.position === 1).id;
  const otherOptionId = options.find(row => row.poll_id === otherPollId).id;
  const rejectSql = (sql, values, code, constraint) => assert.rejects(
    withTransaction(db => db.query(sql, values)),
    error => error.code === code && (!constraint || error.constraint === constraint));
  const voteSql = 'INSERT INTO owner_news_poll_votes(poll_id, option_id, user_uid) VALUES ($1,$2,$3)';
  await rejectSql(`${voteSql},($1,$2,$3)`, [pollId, optionId, voterUid], '23505');
  // Use an unvoted poll so a duplicate primary key cannot mask the composite FK failure.
  await rejectSql(voteSql, [otherPollId, optionId, voterUid], '23503');
  await withTransaction(db => db.query(voteSql, [pollId, optionId, voterUid]));
  assert.equal((await client.query('SELECT COUNT(*)::integer AS count FROM owner_news_poll_votes WHERE poll_id=$1', [pollId])).rows[0].count, 1);
  for (const choice of [optionId, secondOptionId]) {
    await rejectSql(voteSql, [pollId, choice, voterUid], '23505', 'owner_news_poll_votes_pkey');
  }
  await rejectSql(voteSql, [otherPollId, otherOptionId, `missing-${voterUid}`], '23503');
  await rejectSql('INSERT INTO owner_news_poll_options(poll_id,label,position) VALUES ($1,\'Duplicada\',0)', [pollId], '23505');
  for (const [column, value] of [['title', ' '], ['title', 'x'.repeat(81)], ['question', ' '],
    ['question', 'x'.repeat(241)], ['description', 'x'.repeat(601)], ['closing', 'x'.repeat(201)],
    ['status', 'scheduled'], ['version', 0]]) {
    await rejectSql(`UPDATE owner_news_polls SET ${column}=$2 WHERE id=$1`, [pollId, value], '23514');
  }
  for (const [column, value] of [['label', ' '], ['label', 'x'.repeat(101)], ['position', -1], ['position', 6]]) {
    await rejectSql(`UPDATE owner_news_poll_options SET ${column}=$2 WHERE id=$1`, [optionId, value], '23514');
  }
  await withTransaction(db => db.query("UPDATE owner_news_polls SET status='open' WHERE id=$1", [pollId]));
  await rejectSql("UPDATE owner_news_polls SET status='open' WHERE id=$1", [otherPollId], '23505', 'owner_news_one_open_poll');
  await rejectSql('DELETE FROM owner_news_poll_options WHERE id=$1', [optionId], '23503');
  console.log('owner-news integration: poll checks, composite vote FK, one vote/user, option positions and one open poll ok');

  let runtimePollId;
  await withTransaction(async db => {
    await db.query('SET LOCAL ROLE portal_api');
    const { rows: [poll] } = await db.query(`INSERT INTO owner_news_polls(title,question)
      VALUES ('Runtime P1','Pergunta runtime?') RETURNING id`);
    runtimePollId = poll.id;
    const { rows: [option] } = await db.query(`INSERT INTO owner_news_poll_options(poll_id,label,position)
      VALUES ($1,'Runtime',0) RETURNING id`, [poll.id]);
    await db.query(voteSql, [poll.id, option.id, voterUid]);
    assert.equal((await db.query('UPDATE owner_news_polls SET version=version+1 WHERE id=$1 RETURNING version', [poll.id])).rows[0].version, 2);
    assert.equal((await db.query("UPDATE owner_news_poll_options SET label='Alterada' WHERE id=$1", [option.id])).rowCount, 1);
    assert.equal((await db.query('UPDATE owner_news_poll_votes SET created_at=NOW() WHERE poll_id=$1', [poll.id])).rowCount, 1);
    const { rows } = await db.query(`SELECT p.version, o.label, v.user_uid FROM owner_news_polls p
      JOIN owner_news_poll_options o ON o.poll_id=p.id JOIN owner_news_poll_votes v ON v.poll_id=p.id AND v.option_id=o.id
      WHERE p.id=$1`, [poll.id]);
    assert.deepEqual(rows, [{ version: 2, label: 'Alterada', user_uid: voterUid }]);
    assert.equal((await db.query('DELETE FROM owner_news_poll_votes WHERE poll_id=$1', [poll.id])).rowCount, 1);
    assert.equal((await db.query('DELETE FROM owner_news_poll_options WHERE poll_id=$1', [poll.id])).rowCount, 1);
    assert.equal((await db.query('DELETE FROM owner_news_polls WHERE id=$1', [poll.id])).rowCount, 1);
    // Leave a real mutation pending: deleting the runtime fixture alone cannot prove rollback.
    await db.query("UPDATE owner_news_polls SET title='Rollback pending' WHERE id=$1", [pollId]);
  }, { rollback: true });
  assert.equal((await client.query('SELECT id FROM owner_news_polls WHERE id=$1', [runtimePollId])).rowCount, 0);
  assert.equal((await client.query('SELECT title FROM owner_news_polls WHERE id=$1', [pollId])).rows[0].title, 'Fixture P1');
  console.log('owner-news integration: SET LOCAL ROLE portal_api INSERT/SELECT/UPDATE/DELETE on all poll tables with ROLLBACK ok');

  await withTransaction(db => db.query('DELETE FROM users WHERE uid=$1', [voterUid]));
  assert.equal((await client.query('SELECT * FROM owner_news_poll_votes WHERE poll_id=$1', [pollId])).rowCount, 0);
  assert.deepEqual((await client.query('SELECT created_by, updated_by FROM owner_news_polls WHERE id=$1', [pollId])).rows,
    [{ created_by: null, updated_by: null }]);
  assert.equal((await client.query('SELECT id FROM owner_news_poll_options WHERE poll_id=$1', [pollId])).rowCount, 2);
  // Deleting the parent must cascade both options and votes, despite the option FK's NO ACTION policy.
  await client.query(voteSql, [pollId, optionId, uid]);
  await withTransaction(db => db.query('DELETE FROM owner_news_polls WHERE id=$1', [pollId]));
  assert.equal((await client.query('SELECT id FROM owner_news_poll_options WHERE poll_id=$1', [pollId])).rowCount, 0);
  assert.equal((await client.query('SELECT * FROM owner_news_poll_votes WHERE poll_id=$1', [pollId])).rowCount, 0);
  console.log('owner-news integration: user deletion removes vote, nulls actors, preserves poll/options; parent deletion cascades ok');
}
async function checkPollServiceAndRoutes() {
  const content = { title: 'Fixture P2', question: 'Pergunta sintética P2?', description: '', closing: 'Obrigada.', options: ['Cultura', 'Tecnologia'] };
  const tx = operation => withTransaction(async db => {
    await db.query('SET LOCAL ROLE portal_api');
    return operation(db);
  });
  const make = async () => {
    const poll = await tx(db => createPollDraft(db, content, uid));
    pollIds.push(poll.id);
    return poll;
  };
  for (let index = 0; index < 3; index += 1) {
    const user = `P2-CaseSensitive-${randomUUID()}`;
    pollUserIds.push(user);
    await client.query('INSERT INTO users(uid,email,name) VALUES ($1,$2,$3)', [user, `${user}@example.com`, 'Pessoa sintética P2']);
  }
  const [firstUid, secondUid, thirdUid] = pollUserIds;
  const api = supertest(ownerNewsApp(pool, uid, firstUid));
  const admin = (method, path = '') => api[method](`/api/cms/owner-news/polls${path}`).set('Authorization', 'Bearer admin');
  const reader = (method, path) => api[method](`/api/announcements/polls${path}`).set('Authorization', 'Bearer employee');
  assert.equal(await readCurrentPoll(pool, firstUid), null);
  assert.deepEqual((await reader('get', '/current').expect(200)).body, { poll: null });
  const draft = (await admin('post').send(content).expect(201)).body;
  pollIds.push(draft.id);
  assert.equal(draft.version, 1);
  assert.equal(draft.total_votes, 0);
  assert.ok(draft.options.every(option => option.votes === 0 && option.percentage === 0));
  await reader('get', `/${draft.id}`).expect(404);
  await reader('post', `/${draft.id}/votes`).send({ option_id: draft.options[0].id }).expect(404);
  const saves = await Promise.all([0, 1].map(() => admin('put', `/${draft.id}/draft`).send({ ...content, expected_version: 1 })));
  assert.deepEqual(saves.map(res => res.status).sort(), [200, 409]);
  const saved = saves.find(res => res.status === 200).body;
  assert.equal(saved.version, 2);
  assert.notEqual(saved.options[0].id, draft.options[0].id);
  await admin('post', `/${draft.id}/publish`).send({ expected_version: 1 }).expect(409);
  const published = (await admin('post', `/${draft.id}/publish`).send({ expected_version: 2 }).expect(200)).body;
  assert.equal(published.status, 'open');
  assert.equal(published.version, 3);
  assert.equal((await reader('get', '/current').expect(200)).body.poll.id, published.id);
  await admin('put', `/${draft.id}/draft`).send({ ...content, expected_version: 3 }).expect(409);
  const other = await make();
  const conflict = await admin('post', `/${other.id}/publish`).send({ expected_version: 1 }).expect(409);
  assert.equal(conflict.body.reason, 'active_poll_exists');
  assert.equal(conflict.body.requestId, 'owner-news-test');
  assert.equal((await readPoll(pool, other.id, uid, { includeDraft: true })).version, 1);
  const listing = await admin('get', '?status=open&limit=1').expect(200);
  assert.equal(listing.headers['x-total-count'], '1');
  assert.equal(listing.body[0].id, published.id);
  const emptyPage = await admin('get', '?status=open&offset=50').expect(200);
  assert.equal(emptyPage.headers['x-total-count'], '1');
  assert.deepEqual(emptyPage.body, []);
  const [optionA, optionB] = published.options.map(option => option.id);
  await assert.rejects(tx(db => voteOnPoll(db, published.id, other.options[0].id, firstUid)), error => error.status === 400 && error.code === 'invalid_option');
  assert.equal((await readPoll(pool, published.id, firstUid)).total_votes, 0);
  const attempts = await Promise.allSettled([
    tx(db => voteOnPoll(db, published.id, optionA, firstUid)),
    tx(db => voteOnPoll(db, published.id, optionB, firstUid)),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'already_voted').length, 1);
  const stored = await pool.query('SELECT option_id,user_uid FROM owner_news_poll_votes WHERE poll_id=$1', [published.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].user_uid, firstUid);
  const choice = stored.rows[0].option_id;
  const retry = await tx(db => voteOnPoll(db, published.id, choice, firstUid));
  assert.equal(retry.recorded, false);
  assert.equal(retry.poll.total_votes, 1);
  const uppercaseRetry = await reader('post', `/${published.id.toUpperCase()}/votes`).send({ option_id: choice.toUpperCase() }).expect(200);
  assert.equal(uppercaseRetry.body.viewer_option_id, choice);
  await reader('post', `/${published.id}/votes`).send({ option_id: choice === optionA ? optionB : optionA }).expect(409);
  assert.equal((await reader('get', `/${published.id}`).expect(200)).body.viewer_option_id, choice);
  await reader('post', `/${published.id}/votes`).send({ option_id: optionA, user_uid: secondUid }).expect(400);
  const second = await tx(db => voteOnPoll(db, published.id, optionB, secondUid));
  assert.equal(second.recorded, true);
  assert.equal(second.poll.total_votes, 2);
  assert.equal(second.poll.viewer_option_id, optionB);
  assert.equal((await readPoll(pool, published.id, thirdUid)).viewer_option_id, null);
  assert.deepEqual(Object.keys(second.poll).sort(), ['id', 'title', 'question', 'description', 'closing', 'status', 'version', 'options', 'total_votes', 'viewer_option_id'].sort());
  assert.ok(second.poll.options.every(option => Object.keys(option).sort().join(',') === 'id,label,percentage,votes'));
  assert.equal(JSON.stringify(second.poll).includes(firstUid), false);
  console.log('owner-news integration: P2 routes draft isolation/CAS/freeze/list/conflicts; runtime-role different-choice race, UUID retry, identity and DTO privacy ok');

  // Deterministic lock ordering: hold close's row lock, dispatch a competing vote,
  // observe its SQL dispatch, then commit close. No sleeps or timing guesses.
  const closer = await pool.connect();
  let voteDispatched;
  const dispatched = new Promise(resolve => { voteDispatched = resolve; });
  let pendingVote;
  try {
    await closer.query('BEGIN');
    await closer.query('SELECT id FROM owner_news_polls WHERE id=$1 FOR UPDATE', [published.id]);
    pendingVote = tx(db => voteOnPoll({ query(sql, values) {
      const pending = db.query(sql, values);
      if (sql.includes('FOR UPDATE')) voteDispatched();
      return pending;
    } }, published.id, optionA, thirdUid));
    const rejected = assert.rejects(pendingVote, error => error.status === 409 && error.code === 'poll_closed');
    await dispatched;
    await closePoll(closer, published.id, 3, uid);
    await closer.query('COMMIT');
    await rejected;
  } finally {
    await closer.query('ROLLBACK');
    closer.release();
    if (pendingVote) await pendingVote.catch(() => {});
  }
  assert.equal((await readPoll(pool, published.id, firstUid)).total_votes, 2);
  const closedRetry = await tx(db => voteOnPoll(db, published.id, choice, firstUid));
  assert.equal(closedRetry.recorded, false);
  assert.equal(closedRetry.poll.status, 'closed');
  await reader('post', `/${published.id}/votes`).send({ option_id: choice.toUpperCase() }).expect(200);
  await supertest(ownerNewsApp(pool, uid, thirdUid)).post(`/api/announcements/polls/${published.id}/votes`)
    .set('Authorization', 'Bearer employee').send({ option_id: optionA }).expect(409);
  await admin('post', `/${published.id}/publish`).send({ expected_version: 4 }).expect(409);
  await admin('post', `/${published.id}/close`).send({ expected_version: 4 }).expect(409);
  assert.equal((await readCurrentPoll(pool, thirdUid)).id, published.id);
  await client.query('DELETE FROM users WHERE uid=$1', [secondUid]);
  const afterDeletion = await readPoll(pool, published.id, firstUid);
  assert.equal(afterDeletion.total_votes, 1);
  assert.equal(afterDeletion.options.find(option => option.id === choice).percentage, 100);
  assert.equal(afterDeletion.viewer_option_id, choice);
  console.log('owner-news integration: P2 close-before-new-vote lock, closed retry, no reopening and post-user-deletion aggregates ok');

  // Concurrent publication of DIFFERENT drafts exercises the unique index, not only CAS.
  const contender = await make();
  const publications = await Promise.all([other, contender].map(poll => admin('post', `/${poll.id}/publish`).send({ expected_version: 1 })));
  assert.deepEqual(publications.map(res => res.status).sort(), [200, 409]);
  assert.equal(publications.find(res => res.status === 409).body.reason, 'active_poll_exists');
  const open = publications.find(res => res.status === 200).body;
  assert.equal((await readCurrentPoll(pool, firstUid)).id, open.id);
  // Concurrent same-choice first votes are successful exactly once.
  const identical = await Promise.all([0, 1].map(() => tx(db => voteOnPoll(db, open.id, open.options[0].id, thirdUid))));
  assert.deepEqual(identical.map(result => result.recorded).sort(), [false, true]);
  assert.equal((await readPoll(pool, open.id, thirdUid)).total_votes, 1);
  const closed = (await admin('post', `/${open.id}/close`).send({ expected_version: 2 }).expect(200)).body;
  assert.equal(closed.total_votes, 1);
  assert.equal((await readCurrentPoll(pool, firstUid)).id, open.id);
  // Corrupted stored drafts cannot publish even if the schema permits one option.
  const malformed = await make();
  await client.query('DELETE FROM owner_news_poll_options WHERE id=$1', [malformed.options[0].id]);
  await admin('post', `/${malformed.id}/publish`).send({ expected_version: 1 }).expect(400);
  assert.equal((await readPoll(pool, malformed.id, uid, { includeDraft: true })).status, 'draft');

  // Audit failure must roll back an otherwise valid vote.
  const auditPoll = await make();
  await tx(db => publishPoll(db, auditPoll.id, 1, uid));
  const failedAuditPool = { async connect() {
    const db = await pool.connect();
    return { release: () => db.release(), query(sql, values) {
      if (sql.includes('INSERT INTO audit_log')) return Promise.reject(new Error('synthetic poll audit failure'));
      return db.query(sql, values);
    } };
  } };
  await supertest(ownerNewsApp(failedAuditPool, uid, firstUid)).post(`/api/announcements/polls/${auditPoll.id}/votes`)
    .set('Authorization', 'Bearer employee').send({ option_id: auditPoll.options[0].id }).expect(500);
  assert.equal((await readPoll(pool, auditPoll.id, firstUid)).total_votes, 0);
  const distinctVoters = await Promise.all([firstUid, thirdUid].map(user =>
    supertest(ownerNewsApp(pool, uid, user)).post(`/api/announcements/polls/${auditPoll.id}/votes`)
      .set('Authorization', 'Bearer employee').send({ option_id: auditPoll.options[0].id }).expect(200)));
  assert.deepEqual(distinctVoters.map(response => response.body.total_votes).sort(), [1, 2]);
  assert.equal((await readPoll(pool, auditPoll.id, firstUid)).total_votes, 2);
  const audit = await client.query("SELECT actor_uid,action,details FROM audit_log WHERE target_type='owner_news_poll' AND target_id=ANY($1::text[]) ORDER BY created_at,id", [pollIds]);
  assert.deepEqual(new Set(audit.rows.map(row => row.action)), new Set(['owner_news.poll.create', 'owner_news.poll.update', 'owner_news.poll.publish', 'owner_news.poll.close', 'owner_news.poll.vote']));
  const votes = audit.rows.filter(row => row.action === 'owner_news.poll.vote');
  assert.deepEqual(votes.map(row => row.details), [{ recorded: false }, { recorded: false }, { recorded: true }, { recorded: true }]);
  assert.deepEqual(votes.slice(0, 2).map(row => row.actor_uid), [firstUid, firstUid]);
  assert.deepEqual(new Set(votes.slice(2).map(row => row.actor_uid)), new Set([firstUid, thirdUid]));
  console.log('owner-news integration: P2 concurrent publication, same-choice and distinct-user votes, stored validation, current replacement and atomic private audit ok');
}
async function documentFixture() {
  const { rows } = await client.query("INSERT INTO cms_documents (content_type, title) VALUES ('announcement', 'Fixture sintética E2') RETURNING id");
  documentIds.push(rows[0].id);
  return rows[0].id;
}
async function revision(documentId, version, status, editorial, content = blocks) {
  const { rows } = await client.query(`INSERT INTO cms_revisions
    (document_id, version, status, blocks, editorial) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [documentId, version, status, JSON.stringify(content), editorial === null ? null : JSON.stringify(editorial)]);
  return rows[0].id;
}
try {
  await checkBundleImport(pool);
  await client.query('INSERT INTO users (uid, email, name) VALUES ($1, $2, $3)', [uid, `${uid}@example.com`, 'Fixture sintética E2']);
  await checkPollSchema();
  await checkPollServiceAndRoutes();
  const documentId = await documentFixture();
  const publishedId = await revision(documentId, 1, 'published', oldEditorial, [{ type: 'paragraph', text: 'Texto publicado.' }]);
  await client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [documentId, publishedId]);
  const draftId = await revision(documentId, 2, 'draft', newEditorial);
  await client.query('UPDATE cms_documents SET draft_revision_id=$2 WHERE id=$1', [documentId, draftId]);
  const visible = await client.query(`SELECT r.editorial FROM cms_documents d
    JOIN cms_revisions r ON r.id=d.published_revision_id WHERE d.id=$1`, [documentId]);
  assert.equal(visible.rows[0].editorial.author, 'Autora A');
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Autora A');
  const url = `/api/cms/documents/${documentId}`;
  await request.post(`${url}/publish`).send({}).expect(200);
  const updated = await getPublishedAnnouncement(pool, documentId);
  assert.equal(updated.editorial.author, 'Autora B');
  assert.deepEqual(updated.content_blocks, blocks);
  console.log('owner-news integration: published body/editorial isolation and atomic route publication ok');

  const created = await request.post('/api/cms/documents').send({ type: 'announcement', title: 'Fixture inicial E2' }).expect(201);
  documentIds.push(created.body.document.id);
  assert.deepEqual(created.body.revision.editorial, { ...oldEditorial, summary: '', author: '' });
  await request.put(`/api/cms/documents/${created.body.document.id}/draft`).send({ blocks, editorial: null }).expect(400);
  for (const explicit of [false, true]) {
    const legacyId = await documentFixture();
    const legacyRevision = await revision(legacyId, 1, 'published', null);
    await client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [legacyId, legacyRevision]);
    const body = explicit ? { blocks, editorial: null } : { blocks };
    const saved = await request.put(`/api/cms/documents/${legacyId}/draft`).send(body).expect(200);
    assert.equal(saved.body.revision.editorial, null);
    assert.equal((await client.query('SELECT editorial IS NULL AS legacy FROM cms_revisions WHERE id=$1', [saved.body.revision.id])).rows[0].legacy, true);
  }
  await assert.rejects(revision(documentId, 99, 'draft', 'null'), /cms_revisions_editorial_object_check/);
  await assert.rejects(client.query(`INSERT INTO cms_revisions (document_id, version, status, blocks, editorial)
    VALUES ($1, 99, 'draft', '[]', 'null'::jsonb)`, [documentId]), /cms_revisions_editorial_object_check/);
  console.log('owner-news integration: native initialization, explicit-null rejection and legacy SQL NULL ok');

  const scheduled = await request.put(`${url}/draft`).send({ blocks, editorial: { ...newEditorial, author: 'Agendada' } }).expect(200);
  await request.post(`${url}/schedule`).send({ scheduled_at: new Date(Date.now() + 60000).toISOString() }).expect(200);
  const later = await request.put(`${url}/draft`).send({ blocks }).expect(200);
  assert.equal(later.body.revision.editorial.author, 'Agendada');
  const canceled = await request.delete(`${url}/schedule`).expect(200);
  assert.equal(canceled.body.draft.id, later.body.revision.id);
  assert.equal(canceled.body.draft.editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT status FROM cms_revisions WHERE id=$1', [scheduled.body.revision.id])).rows[0].status, 'archived');
  await request.post(`${url}/schedule`).send({ scheduled_at: new Date(Date.now() + 60000).toISOString() }).expect(200);
  const newest = await request.put(`${url}/draft`).send({ blocks, editorial: { ...newEditorial, author: 'Posterior' } }).expect(200);
  await client.query("UPDATE cms_documents SET scheduled_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [documentId]);
  assert.equal(await promoteDueScheduledForPool(pool), 1);
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT draft_revision_id FROM cms_documents WHERE id=$1', [documentId])).rows[0].draft_revision_id, newest.body.revision.id);
  // Corrupt synthetic stored metadata to exercise promotion's defensive validation.
  const invalidId = await revision(documentId, 100, 'scheduled', { ...oldEditorial, summary: '' });
  await client.query("UPDATE cms_documents SET scheduled_revision_id=$2, scheduled_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [documentId, invalidId]);
  assert.equal(await promoteDueScheduledForPool(pool), 0);
  assert.equal((await client.query('SELECT status FROM cms_revisions WHERE id=$1', [invalidId])).rows[0].status, 'archived');
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT draft_revision_id FROM cms_documents WHERE id=$1', [documentId])).rows[0].draft_revision_id, newest.body.revision.id);
  console.log('owner-news integration: schedule/cancel/promotion preserve later draft; invalid schedule archived ok');

  const assetSource = await readFile(new URL('../api/routes/cms-assets.js', import.meta.url), 'utf8');
  const helpers = new Function('canManageCms', 'lockCmsAssets', 'validatePublishedBlocksBatch', 'getAuthority', `
    ${assetSource.slice(assetSource.indexOf('const ASSET_MIMES'), assetSource.indexOf('const upload ='))}
    ${assetSource.slice(assetSource.indexOf('function audienceFor'), assetSource.indexOf('function isMalformedMultipart'))}
    ${assetSource.slice(assetSource.indexOf('async function canReadAsset'), assetSource.indexOf('function uploadMiddleware'))}
    ${assetSource.slice(assetSource.indexOf('async function reserveUnreferencedAsset'), assetSource.indexOf('function reservationIsActive'))}
    return { canReadAsset, reserveUnreferencedAsset };`)(canManageCms, lockCmsAssets, validatePublishedBlocksBatch, getAuthority);
  for (const mime of ['application/pdf', 'image/png']) {
    const { rows: [asset] } = await client.query("INSERT INTO cms_assets (original_name, mime_type, byte_size) VALUES ('Fixture E2', $1, 1) RETURNING id, mime_type", [mime]);
    assetIds.push(asset.id);
    const profile = [{ type: 'profile', name: 'Pessoa sintética', text: 'Biografia sintética.', asset_id: asset.id, alt: 'Retrato sintético' }];
    const saved = await request.put(`${url}/draft`).send({ blocks: profile, editorial: oldEditorial });
    assert.equal(saved.status, mime === 'image/png' ? 200 : 400);
    if (mime !== 'image/png') continue;
    assert.equal(await helpers.canReadAsset(client, { uid: 'employee', permissions: {} }, asset), false);
    await request.post(`${url}/publish`).send({}).expect(200);
    assert.equal(await helpers.canReadAsset(client, { uid: 'employee', permissions: {} }, asset), true);
    assert.equal((await getPublishedAnnouncement(pool, documentId)).content_blocks[0].asset_id, asset.id);
    await client.query('BEGIN');
    try {
      assert.deepEqual(await helpers.reserveUnreferencedAsset(client, asset.id), { referenced: true, cleared: false });
    } finally { await client.query('ROLLBACK'); }
  }
  const history = await request.get(`${url}/revisions`).expect(200);
  assert.ok(history.body.every(row => Object.hasOwn(row, 'editorial')));
  const view = await request.get(url).expect(200);
  assert.equal(view.body.published.editorial.author, 'Autora A');
  await client.query('UPDATE cms_revisions SET editorial=$2 WHERE id=$1', [view.body.published.id, JSON.stringify({ version: 99 })]);
  assert.equal(await getPublishedAnnouncement(pool, documentId), null);
  assert.equal((await listPublishedAnnouncements(pool, 100, 0)).rows.some(row => row.id === documentId), false);
  console.log('owner-news integration: profile MIME, collaborator access, flat-reference retention and invalid-publication filtering ok');
  for (const sql of [
    'INSERT INTO owner_news_home(singleton) VALUES (FALSE)',
    'UPDATE owner_news_home SET version=0',
    "UPDATE owner_news_home SET draft='[]'::jsonb",
    "UPDATE owner_news_home SET published='null'::jsonb",
  ]) await assert.rejects(client.query(sql), error => error.code === '23514');
  console.log('owner-news integration: home singleton/version/object constraints ok');
  homeSnapshot = (await client.query('SELECT * FROM owner_news_home WHERE singleton=TRUE')).rows[0];
  const news = supertest(ownerNewsApp(pool, uid));
  const adminHome = (method, path) => news[method](`/api/cms/owner-news/home${path}`).set('Authorization', 'Bearer admin');
  const publicHome = () => news.get('/api/announcements/home').set('Authorization', 'Bearer employee');
  const content = { version: 1, eyebrow: 'FIXTURE E3', headline: 'Abertura\nsintética', summary: 'Resumo sintético.' };
  const initial = await adminHome('get', '').expect(200);
  const before = await publicHome().expect(200);
  const concurrent = await Promise.all([0, 1].map(() => adminHome('put', '/draft')
    .send({ expected_version: initial.body.version, content })));
  assert.deepEqual(concurrent.map(res => res.status).sort(), [200, 409]);
  const saved = concurrent.find(res => res.status === 200).body;
  assert.deepEqual((await publicHome().expect(200)).body, before.body);
  await adminHome('post', '/publish').send({ expected_version: initial.body.version }).expect(409);
  const publications = await Promise.all([0, 1].map(() => adminHome('post', '/publish')
    .send({ expected_version: saved.version })));
  assert.deepEqual(publications.map(res => res.status).sort(), [200, 409]);
  const published = publications.find(res => res.status === 200).body;
  assert.equal(published.draft, null);
  assert.deepEqual((await publicHome().expect(200)).body, { content });
  assert.equal((await adminHome('post', '/publish').send({ expected_version: published.version }).expect(409)).body.reason, 'draft_required');
  await adminHome('put', '/draft').send({ expected_version: published.version, content }).expect(200);
  await client.query('UPDATE owner_news_home SET draft=$1::jsonb WHERE singleton=TRUE', [JSON.stringify({ ...content, summary: '<b>Inválido</b>' })]);
  await adminHome('post', '/publish').send({ expected_version: published.version + 1 }).expect(400);
  assert.deepEqual((await publicHome().expect(200)).body, { content });
  const audit = await client.query("SELECT action FROM audit_log WHERE actor_uid=$1 AND target_type='owner_news_home'", [uid]);
  assert.equal(audit.rows.length, 3);
  // A failed audit insert must roll the successful draft UPDATE back as well.
  const failedAuditPool = { async connect() {
    const db = await pool.connect();
    return { release: () => db.release(), query: (sql, values) => {
      if (sql.includes('INSERT INTO audit_log')) return Promise.reject(new Error('synthetic audit failure'));
      return db.query(sql, values);
    } };
  } };
  await supertest(ownerNewsApp(failedAuditPool, uid)).put('/api/cms/owner-news/home/draft')
    .set('Authorization', 'Bearer admin').send({ expected_version: published.version + 1, content }).expect(500);
  const afterFailure = await adminHome('get', '').expect(200);
  assert.equal(afterFailure.body.version, published.version + 1);
  assert.equal(afterFailure.body.draft.summary, '<b>Inválido</b>');
  console.log('owner-news integration: real home routes, concurrent CAS save/publish, draft isolation, lock validation and audit rollback ok');

  const category = `Fixture E3 & ${uid}`;
  const feedIds = [];
  for (let i = 0; i < 27; i += 1) {
    const docId = await documentFixture();
    feedIds.push(docId);
    const revId = await revision(docId, 1, 'published', oldEditorial);
    await client.query(`UPDATE cms_documents SET published_revision_id=$2, category=$3,
      published_at=$4, updated_at=$4 WHERE id=$1`, [docId, revId, category, new Date(Date.UTC(2026, 8, 30 - i))]);
  }
  const feed = path => news.get(`/api/announcements${path}`).set('Authorization', 'Bearer employee');
  const list = await feed(`?kind=article&limit=1&category=${encodeURIComponent(category)}`).expect(200);
  assert.equal(list.headers['x-total-count'], '27');
  assert.equal(list.body[0].id, feedIds[0]);
  assert.equal(list.body[0].read_time_minutes, 1);
  const nav = await feed(`/${feedIds[25].toUpperCase()}/navigation?category=${encodeURIComponent(category)}`).expect(200);
  assert.equal(nav.body.previous.id, feedIds[24]);
  assert.equal(nav.body.next.id, feedIds[26]);
  const categories = await feed('/categories?kind=article&with_counts=true').expect(200);
  assert.equal(categories.body.categories.find(row => row.name === category).count, 27);
  assert.equal((await feed(`/${feedIds[0].toUpperCase()}`).expect(200)).body.id, feedIds[0]);
  console.log('owner-news integration: PostgreSQL feed/counts/category encoding/full navigation and uppercase UUIDs ok');
  console.log('owner-news integration: ok');
} finally {
  try {
    await client.query('ROLLBACK');
    if (pollIds.length) await client.query('DELETE FROM owner_news_polls WHERE id=ANY($1::uuid[])', [pollIds]);
    await client.query('DELETE FROM users WHERE uid=$1', [voterUid]);
    if (homeSnapshot) await client.query(`UPDATE owner_news_home SET version=$1, draft=$2::jsonb, published=$3::jsonb,
      published_at=$4, updated_by=$5, updated_at=$6 WHERE singleton=TRUE`, [homeSnapshot.version,
      homeSnapshot.draft === null ? null : JSON.stringify(homeSnapshot.draft),
      homeSnapshot.published === null ? null : JSON.stringify(homeSnapshot.published),
      homeSnapshot.published_at, homeSnapshot.updated_by, homeSnapshot.updated_at]);
    await client.query('DELETE FROM audit_log WHERE actor_uid=$1 OR target_id=ANY($2::text[])', [uid, [...documentIds, ...pollIds]]);
    await client.query('DELETE FROM users WHERE uid=ANY($1::text[])', [pollUserIds]);
    await client.query('DELETE FROM cms_documents WHERE id=ANY($1::uuid[])', [documentIds]);
    await client.query('DELETE FROM cms_assets WHERE id=ANY($1::uuid[])', [assetIds]);
    await client.query('DELETE FROM users WHERE uid=$1', [uid]);
    assert.equal((await client.query('SELECT COUNT(*)::integer AS count FROM cms_revisions WHERE document_id=ANY($1::uuid[])', [documentIds])).rows[0].count, 0);
    console.log('owner-news integration: synthetic fixtures cleaned');
  } finally {
    client.release();
    await pool.end();
  }
}
