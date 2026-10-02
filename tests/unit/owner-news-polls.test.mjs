import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ownerNewsApp } from '../helpers/owner-news-app.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { normalizePollDraft, updatePollDraft, publishPoll, closePoll, voteOnPoll, readPoll } = require('./owner-news/polls');
const supertest = require('supertest');
const id = 'abcdef01-1234-4123-8123-123456789abc';
const valid = { title: 'ENQUETE OWNER NEWS', question: 'O que você quer ler?', description: '', closing: 'Obrigada.', options: ['Cultura', 'Tecnologia'] };

test('poll drafts accept only bounded plain text and 2–6 normalized distinct options', () => {
  assert.deepEqual(normalizePollDraft(valid), valid);
  assert.deepEqual(normalizePollDraft({ ...valid, options: [' A ', 'B'] }).options, ['A', 'B']);
  assert.ok(normalizePollDraft({ ...valid, options: ['A', 'B', 'C', 'D', 'E', 'F'] }));
  for (const change of [
    { options: ['A'] }, { options: Array(7).fill('A') }, { options: ['Cultura', ' cultura '] },
    { options: ['Ａ', 'a'] }, { options: ['A  B', 'a b'] }, { options: ['A\nB', 'C'] },
    { options: ['onclick=alert(1)', 'B'] }, { options: ['<b>A</b>', 'B'] },
    { options: ['x'.repeat(101), 'B'] }, { options: [' ', 'B'] },
    { title: '' }, { question: '<b>Pergunta</b>' }, { description: 'javascript:foo' },
    { title: 'x'.repeat(81) }, { question: 'x'.repeat(241) }, { description: 'x'.repeat(601) },
    { closing: 'x'.repeat(201) }, { user_uid: 'forged-user' }, { status: 'open' }, { total_votes: 99 },
  ]) assert.equal(normalizePollDraft({ ...valid, ...change }), null, JSON.stringify(change));
  for (const value of [null, [], {}, 'poll']) assert.equal(normalizePollDraft(value), null);
});

test('locked mutations reject missing polls, stale versions, published edits and reopening', async () => {
  for (const [operation, status, version, code] of [
    [db => updatePollDraft(db, id, valid, 1, 'Actor'), 'draft', 2, 'version_conflict'],
    [db => updatePollDraft(db, id, valid, 2, 'Actor'), 'open', 2, 'poll_frozen'],
    [db => publishPoll(db, id, 2, 'Actor'), 'closed', 2, 'poll_frozen'],
    [db => closePoll(db, id, 2, 'Actor'), 'draft', 2, 'poll_not_open'],
    [db => closePoll(db, id, 2, 'Actor'), null, 2, 'poll_not_found'],
  ]) {
    const db = { async query(sql) {
      assert.match(sql, /FOR UPDATE/);
      return { rows: status ? [{ id, status, version }] : [] };
    } };
    await assert.rejects(operation(db), error => error.code === code);
  }
});

test('DTO uses one snapshot, exposes aggregates and only the viewer choice', async () => {
  let calls = 0;
  const poll = await readPoll({ async query(sql, params) {
    calls += 1;
    assert.deepEqual(params, [id, 'CaseSensitiveUID', false]);
    assert.match(sql, /jsonb_agg/);
    return { rows: [{ id, title: 'T', question: 'Q', description: '', closing: '', status: 'open', version: 2,
      options: [{ id: 'a', label: 'A', votes: '1', position: 0 }, { id: 'b', label: 'B', votes: '2', position: 1 }], viewer_option_id: 'a' }] };
  } }, id, 'CaseSensitiveUID');
  assert.equal(calls, 1);
  assert.equal(poll.total_votes, 3);
  assert.deepEqual(poll.options, [{ id: 'a', label: 'A', votes: 1, percentage: 33 }, { id: 'b', label: 'B', votes: 2, percentage: 67 }]);
  assert.deepEqual(Object.keys(poll).sort(), ['id', 'title', 'question', 'description', 'closing', 'status', 'version', 'options', 'total_votes', 'viewer_option_id'].sort());
});

test('vote checks the locked state and existing choice before any write', async () => {
  for (const [status, previous, code] of [['draft', null, 'poll_not_found'], ['closed', null, 'poll_closed'], ['open', 'other', 'already_voted']]) {
    const db = { async query(sql) {
      if (sql.includes('FOR UPDATE')) return { rows: [{ id, status }] };
      assert.match(sql, /SELECT option_id/);
      return { rows: previous ? [{ option_id: previous }] : [] };
    } };
    await assert.rejects(voteOnPoll(db, id, id, 'Viewer'), error => error.code === code);
  }
});

test('poll routes authenticate, apply real CMS permission and reject malformed transport before SQL', async () => {
  const api = supertest(ownerNewsApp({ query() { throw new Error('Unexpected SQL'); }, connect() { throw new Error('Unexpected connection'); } }));
  for (const path of ['/api/announcements/polls/current', `/api/announcements/polls/${id}`, '/api/cms/owner-news/polls']) await api.get(path).expect(401);
  for (const [method, path] of [['post', ''], ['put', `/${id}/draft`], ['post', `/${id}/publish`], ['post', `/${id}/close`]]) {
    await api[method](`/api/cms/owner-news/polls${path}`).send({}).expect(401);
    await api[method](`/api/cms/owner-news/polls${path}`).set('Authorization', 'Bearer employee').send({}).expect(403);
  }
  await api.get('/api/cms/owner-news/polls').set('Authorization', 'Bearer employee').expect(403);
  await api.post(`/api/announcements/polls/${id}/votes`).send({ option_id: id }).expect(401);
  const get = path => api.get(path).set('Authorization', 'Bearer admin');
  for (const suffix of ['?status=scheduled', '?limit=0', '?status=open&status=closed', '?unexpected=x']) await get(`/api/cms/owner-news/polls${suffix}`).expect(400);
  for (const suffix of ['/current?x=1', '/invalid', `/${id}?x=1`]) await get(`/api/announcements/polls${suffix}`).expect(400);
  for (const body of [{ option_id: id, user_uid: 'forged' }, { option_id: 'bad' }, { option_id: id, votes: 3 }, {}]) {
    const res = await api.post(`/api/announcements/polls/${id}/votes`).set('Authorization', 'Bearer employee').send(body).expect(400);
    assert.equal(res.body.reason, 'invalid_request');
    assert.equal(res.body.requestId, 'owner-news-test');
  }
  for (const body of [{ ...valid, expected_version: 1 }, { ...valid, viewer_option_id: id }]) await api.post('/api/cms/owner-news/polls').set('Authorization', 'Bearer admin').send(body).expect(400);
  for (const body of [valid, { ...valid, expected_version: 1, status: 'open' }, { ...valid, expected_version: 1, options: ['A'] }]) {
    await api.put(`/api/cms/owner-news/polls/${id}/draft`).set('Authorization', 'Bearer admin').send(body).expect(400);
  }
  for (const expected_version of [0, '1', 1.5, null]) await api.post(`/api/cms/owner-news/polls/${id}/publish`).set('Authorization', 'Bearer admin').send({ expected_version }).expect(400);
});
