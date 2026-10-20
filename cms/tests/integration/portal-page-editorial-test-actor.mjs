import { createServer } from 'node:http'

const V1_RESOLVE = '/api/internal/editorial/session/resolve'
const V2_RESOLVE = '/api/internal/editorial/admin/session/resolve'
const REVOKE = '/api/internal/editorial/session/revoke'
const AUTHORITY = '/api/internal/editorial/authority'
const ACTOR_CHECK = '/api/internal/editorial/actor/check'

async function readJSON(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 16 * 1024) return { tooLarge: true }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return null }
}

function deny(response) {
  response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"reason":"editorial_session_invalid"}')
}

/** Test-only Portal V2 bridge. Revocation is stateful and scoped to one run cookie. */
export function createLocalActorTransport(config, serviceSecret) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const actor = {
    version: 2,
    uid: `portal-page-task4-${config.runId}`,
    email: `${config.runId}@example.invalid`,
    name: 'Portal Pages Task 4 synthetic editor',
    capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false },
  }
  const revokedCookies = new Set()
  // A second deterministic test-only cookie proves revocation is scoped to the
  // exact target and does not clear unrelated fixture authority state.
  const acceptedCookies = new Set([config.runId, `${config.runId}-other-fixture-cookie`])

  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.authorization !== `Bearer ${serviceSecret}`) {
      deny(response)
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === AUTHORITY) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"mode":"payload","epoch":1}')
      return
    }
    if (request.method === 'POST' && (url.pathname === V1_RESOLVE || url.pathname === V2_RESOLVE)) {
      const body = await readJSON(request)
      if (body?.tooLarge) { response.writeHead(413).end(); return }
      if (!body || !acceptedCookies.has(body.cookie) || revokedCookies.has(body.cookie)) { deny(response); return }
      if (url.pathname === V1_RESOLVE) { deny(response); return }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ actor, expiresAt }))
      return
    }
    if (request.method === 'POST' && url.pathname === REVOKE) {
      const body = await readJSON(request)
      if (body?.tooLarge) { response.writeHead(413).end(); return }
      if (!body || body.cookie !== config.runId) { deny(response); return }
      revokedCookies.add(body.cookie)
      response.writeHead(204).end()
      return
    }
    if (request.method === 'POST' && url.pathname === ACTOR_CHECK) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ actor: {
        uid: actor.uid, email: actor.email, name: actor.name, canManageNews: true,
      } }))
      return
    }
    response.writeHead(404).end()
  })
}
