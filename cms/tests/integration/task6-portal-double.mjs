// TEST ONLY preload: actual CMS/Next/REST use this explicitly synthetic Portal transport.
// No production import references this file.
import { readFileSync } from 'node:fs'
import path from 'node:path'
const directory = process.env.TASK6_PRIVATE_DIR || ''
const url = new URL(process.env.CMS_DATABASE_URL || 'http://invalid')
if (process.env.TASK6_DISPOSABLE !== 'cms_task6_test' || url.hostname !== '127.0.0.1' || url.port !== '55441' ||
  url.pathname !== '/cms_task6_test' || path.dirname(directory) !== path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode') ||
  !path.basename(directory).startsWith('ownerinc-task6-')) throw new Error('Task6 browser preload refuses other environments')
const { actor } = JSON.parse(readFileSync(path.join(directory, 'browser-fixture.json'), 'utf8'))
const original = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (!url.startsWith('http://127.0.0.1:18086/api/internal/editorial/')) return original(input, init)
  if (init?.headers?.Authorization !== `Bearer ${process.env.PAYLOAD_TO_PORTAL_SECRET}`) return Response.json({}, { status: 401 })
  if (url.endsWith('/authority')) return Response.json({ mode: 'payload', epoch: 1 })
  const body = JSON.parse(init?.body || '{}')
  if (url.endsWith('/actor/check') && body.uid === actor.uid) return Response.json({ actor })
  if (url.endsWith('/session/resolve') && body.cookie === 'task6-synthetic-browser-cookie') return Response.json({ actor, expiresAt: new Date(Date.now() + 3600000).toISOString() })
  return Response.json({ reason: 'editorial_session_invalid' }, { status: 401 })
}
