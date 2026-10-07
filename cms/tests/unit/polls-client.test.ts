import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedPollOperation, validPollPath } from '../../src/admin/polls-client.js'
import { pollBaseline, pollDraft, pollMutation, validPollDraft } from '../../src/admin/polls-state.js'
import type { Poll } from '../../src/admin/polls-client.js'
import { proxyPortalPolls } from '../../src/endpoints/portal-polls.js'

const id = '12345678-1234-4234-8234-123456789abc'
test('view de enquete não vira proxy arbitrário', () => {
  assert.equal(allowedPollOperation('GET', '/'), true)
  assert.equal(allowedPollOperation('POST', '/'), true)
  assert.equal(allowedPollOperation('DELETE', '/'), false)
  assert.equal(allowedPollOperation('GET', 'https://outside.example/'), false)
  assert.equal(allowedPollOperation('PUT', `/${id}/draft`), true)
  assert.equal(allowedPollOperation('POST', `/${id}/publish`), true)
  assert.equal(allowedPollOperation('POST', `/${id}/close`), true)
  for (const path of [`/${id}`, `/${id}/votes`, `/${id}/draft/`, '//outside/', '/%2f', '/./', '/?url=x']) {
    assert.equal(allowedPollOperation('GET', path), false, path)
  }
})
test('poll form baseline and original expected version remain independent from unsaved inputs', () => {
  const poll: Poll = { id, version: 3, status: 'draft', title: 'Original', question: 'Question', description: '', closing: '', total_votes: 0, options: [{ id, label: 'A', votes: 0, percentage: 0 }, { id, label: 'B', votes: 0, percentage: 0 }] }
  const draft = pollDraft(poll), baseline = pollBaseline(draft); draft.title = 'Unsaved'
  assert.notEqual(pollBaseline(draft), baseline)
  assert.equal(pollMutation('draft', poll, draft).body.expected_version, 3)
  assert.equal(pollMutation('publish', poll, draft).body.expected_version, 3)
  assert.equal(poll.title, 'Original'); assert.equal(validPollDraft(draft), true)
  assert.equal(validPollDraft({ ...draft, options: ['A', ' a '] }), false)
})
test('server proxy enforces Origin, cookie, exact paths/queries and sanitizes service errors', async () => {
  const environment = { portalPublicURL: 'https://portal.test', portalInternalURL: 'http://127.0.0.1:19999', payloadToPortalSecret: 'private-test-secret' } as Parameters<typeof proxyPortalPolls>[1]
  let calls = 0
  const transport: typeof fetch = async (url, options) => {
    calls++; assert.equal(new Headers(options?.headers).get('cookie'), '__Host-ownerinc-editorial=cookie'); assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer private-test-secret')
    assert.equal(String(url), 'http://127.0.0.1:19999/api/internal/editorial/polls?limit=20&offset=0')
    return Response.json([], { headers: { 'X-Total-Count': '37', 'Set-Cookie': 'do-not-forward', 'Authorization': 'private' } })
  }
  const request = (suffix: string, method = 'GET', cookie = '__Host-ownerinc-editorial=cookie', origin = 'https://portal.test') => new Request(`https://portal.test/editorial/api/portal-polls${suffix}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{"expected_version":1}' } : {}) })
  for (const suffix of ['?url=http://outside', '?limit=20&limit=20', '/%2f', `/${id}/votes`]) assert.equal((await proxyPortalPolls(request(suffix), environment, transport)).status, 400)
  assert.equal((await proxyPortalPolls(request('', 'GET', ''), environment, transport)).status, 401)
  assert.equal((await proxyPortalPolls(request('', 'POST', undefined, 'https://outside'), environment, transport)).status, 403)
  assert.equal(calls, 0)
  const result = await proxyPortalPolls(request(''), environment, transport)
  assert.equal(result.headers.get('X-Total-Count'), '37'); assert.equal(result.headers.get('Set-Cookie'), null); assert.equal(result.headers.get('Authorization'), null)
  const conflict = await proxyPortalPolls(request(`/${id}/publish`, 'POST'), environment, async () => Response.json({ reason: 'version_conflict', error: 'A enquete foi alterada.' }, { status: 409 }))
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).reason, 'version_conflict')
  const failure = await proxyPortalPolls(request(''), environment, async () => Response.json({ reason: 'editorial_service_unauthorized', error: 'private' }, { status: 401 }))
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /private/)
})
test('list query is exact, scalar and bounded; mutations have no query', () => {
  for (const path of ['/', '/?limit=20&offset=0', '/?limit=20&offset=20&status=draft', '/?status=open']) assert.equal(validPollPath('GET', path), true, path)
  for (const path of ['/?limit=100', '/?offset=-1', '/?offset=1', '/?offset=9007199254740992', '/?status=other', '/?limit=20&limit=20', '/?url=https://outside/', '/?status[]=open', '/?offset=%30', '/?']) assert.equal(validPollPath('GET', path), false, path)
  assert.equal(validPollPath('POST', '/?limit=20'), false)
  assert.equal(validPollPath('POST', `/${id}/publish?x=1`), false)
})
test('server rejects malformed, oversized and extra mutation fields without forwarding any request', async () => {
  const environment = { portalPublicURL: 'https://portal.test', portalInternalURL: 'http://127.0.0.1:19999', payloadToPortalSecret: 'private-test-secret' } as Parameters<typeof proxyPortalPolls>[1]
  let calls = 0
  const transport: typeof fetch = async () => { calls++; return Response.json({}) }
  const draft = { title: 'Título', question: 'Pergunta', description: '', closing: '', options: ['A', 'B'] }
  const invalid = [
    ['', '{', 400], ['', JSON.stringify({ ...draft, uid: 'admin' }), 400], ['', JSON.stringify({ ...draft, options: [{ label: 'A' }, 'B'] }), 400],
    [`/${id}/publish`, '{"expected_version":1,"uid":"admin"}', 400], [`/${id}/close`, '{"expected_version":0}', 400],
    ['', JSON.stringify({ ...draft, description: 'x'.repeat(16384) }), 413],
  ] as const
  for (const [suffix, body, status] of invalid) {
    const req = new Request(`https://portal.test/editorial/api/portal-polls${suffix}`, { method: 'POST', body,
      headers: { Cookie: '__Host-ownerinc-editorial=cookie', Origin: 'https://portal.test', 'Content-Type': 'application/json' } })
    assert.equal((await proxyPortalPolls(req, environment, transport)).status, status)
  }
  assert.equal(calls, 0)
})
