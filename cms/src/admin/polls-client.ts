export const POLLS_ENDPOINT = '/editorial/api/portal-polls'
export function allowedPollOperation(method: string, path: string) {
  if (path === '/') return method === 'GET' || method === 'POST'
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  if (new RegExp(`^/${id}/draft$`, 'i').test(path)) return method === 'PUT'
  if (new RegExp(`^/${id}/(publish|close)$`, 'i').test(path)) return method === 'POST'
  return false
}
export function validPollPath(method: string, path: string) {
  if (typeof path !== 'string' || /[%#\\\s]/.test(path)) return false
  const [pathname, query, extra] = path.split('?')
  if (!allowedPollOperation(method, pathname) || extra !== undefined) return false
  if (query === undefined) return true
  if (method !== 'GET' || pathname !== '/' || !query) return false
  const params = new URLSearchParams(query), seen = new Set<string>()
  for (const [key, value] of params) {
    if (seen.has(key)) return false
    seen.add(key)
    if (key === 'limit' ? value !== '20' : key === 'offset' ? !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) % 20 !== 0
      : key === 'status' ? !['draft', 'open', 'closed'].includes(value) : true) return false
  }
  return params.toString() === query
}
export class PollRequestError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) { super(message) }
}
export function validPollBody(method: string, path: string, body: unknown) {
  if (!allowedPollOperation(method, path) || method === 'GET' || !body || typeof body !== 'object' || Array.isArray(body)) return false
  const value = body as Record<string, unknown>, draft = path === '/' || path.endsWith('/draft')
  const keys = [...(draft ? ['title', 'question', 'description', 'closing', 'options'] : []), ...(path !== '/' ? ['expected_version'] : [])]
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return false
  if (path !== '/' && (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1)) return false
  return !draft || ['title', 'question', 'description', 'closing'].every(key => typeof value[key] === 'string')
    && Array.isArray(value.options) && value.options.length >= 2 && value.options.length <= 6 && value.options.every(option => typeof option === 'string')
}
export type PollDraft = { title: string; question: string; description: string; closing: string; options: string[] }
export type Poll = Omit<PollDraft, 'options'> & { id: string; version: number; status: 'draft' | 'open' | 'closed'; total_votes: number;
  options: { id: string; label: string; votes: number; percentage: number }[] }
export async function requestPolls<T = Poll[]>(path: string, { method = 'GET', body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ data: T; total?: number }> {
  if (!validPollPath(method, path)) throw new PollRequestError(400, 'invalid_request', 'Operação de enquete inválida.')
  const response = await fetch(`${POLLS_ENDPOINT}${path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), signal, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  })
  const data = await response.json()
  if (!response.ok) throw new PollRequestError(response.status, data.reason || 'editorial_unavailable', data.error || 'Não foi possível concluir a operação.')
  const total = response.headers.get('X-Total-Count')
  return { data, ...(total === null ? {} : { total: Number(total) }) }
}
