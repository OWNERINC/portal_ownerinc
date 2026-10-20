import type { Payload, PayloadRequest } from 'payload'

export const pageID = '11111111-1111-4111-8111-111111111111'
export const versionID = '22222222-2222-4222-8222-222222222222'
export const nativePage = {
  title: 'Guia', slug: 'guia', summary: '', cover: null, coverAlt: null, categories: [], body: [],
}

export type EditorialCall = { operation: string; transactionID: unknown; args: unknown }

function copy<T>(value: T): T { return structuredClone(value) }

/** Transaction-aware Payload fake. Commit can deliberately resolve without persistence. */
export function editorialFixture() {
  const calls: EditorialCall[] = []
  const sessions: Record<string, { db: { execute: (query: unknown) => Promise<{ rows: unknown[] }> } }> = {}
  let transactionNumber = 0
  let lostCommit = false
  let versionAfterCommit = false
  let receiptCorruption: 'parent' | 'autosave' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'status' | 'publishedAt' | 'content' | null = null
  let clock = Date.parse('2026-10-19T10:00:00.000Z')
  let state = { pages: new Map<string, Record<string, unknown>>(), versions: new Map<string, Record<string, unknown>>() }
  const staged = new Map<string, typeof state>()
  const nextID = () => `33333333-3333-4333-8333-${String(++transactionNumber).padStart(12, '0')}`
  const stateFor = (req: { transactionID?: unknown }) => {
    const id = String(req.transactionID || '')
    return staged.get(id) || state
  }
  const call = (operation: string, args: unknown) => {
    const req = args && typeof args === 'object' ? (args as { req?: { transactionID?: unknown } }).req : undefined
    calls.push({ operation, transactionID: req?.transactionID, args })
  }
  const sessionFor = (id: string) => ({ db: {
    execute: async (query: unknown) => { calls.push({ operation: 'sql', transactionID: id, args: query }); return { rows: [] } },
  } })
  const payload = {
    config: { i18n: { fallbackLanguage: 'pt' }, admin: { user: 'portal-editors' }, collections: {} }, collections: {},
    db: {
      sessions,
      beginTransaction: async () => {
        const id = `editorial-${++transactionNumber}`
        staged.set(id, copy(state)); sessions[id] = sessionFor(id)
        calls.push({ operation: 'begin', transactionID: id, args: null })
        return id
      },
      commitTransaction: async (id: string) => {
        calls.push({ operation: 'commit', transactionID: id, args: null })
        const snapshot = staged.get(id)
        if (snapshot && !lostCommit) state = copy(snapshot)
        staged.delete(id); delete sessions[id]
        if (receiptCorruption && !lostCommit) {
          const latest = [...state.versions.values()].filter(row => row.latest === true)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
          if (latest) {
            const content = { ...(latest.version as Record<string, unknown>) }
            if (receiptCorruption === 'parent') latest.parent = '99999999-9999-4999-8999-999999999999'
            else if (receiptCorruption === 'autosave') latest.autosave = true
            else if (receiptCorruption === 'updatedAt') latest.updatedAt = '2026-10-19T10:10:10.000Z'
            else if (receiptCorruption === 'createdBy') content.createdBy = 'wrong-creator'
            else if (receiptCorruption === 'updatedBy') content.updatedBy = 'wrong-editor'
            else if (receiptCorruption === 'status') content._status = 'published'
            else if (receiptCorruption === 'publishedAt') content.publishedAt = '2026-10-19T10:10:10.000Z'
            else if (receiptCorruption === 'content') content.title = 'Conteúdo inesperado'
            latest.version = content
          }
        }
        if (versionAfterCommit && !lostCommit) {
          const latest = [...state.versions.values()].filter(row => row.latest === true)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
          if (latest) {
            latest.latest = false
            const next = { ...copy(latest), id: nextID(), latest: true, autosave: true,
              updatedAt: new Date(++clock).toISOString(), version: { ...(latest.version as object), title: 'Edição posterior' } }
            state.versions.set(String(next.id), next)
          }
        }
      },
      rollbackTransaction: async (id: string) => {
        calls.push({ operation: 'rollback', transactionID: id, args: null })
        staged.delete(id); delete sessions[id]
      },
    },
    find: async (args: Record<string, unknown>) => {
      call('find', args)
      return { docs: [], hasNextPage: false }
    },
    findByID: async (args: Record<string, unknown>) => {
      call('findByID', args)
      const current = stateFor(args.req as { transactionID?: unknown })
      if (args.collection === 'portal-page-categories') return { id: args.id, name: 'Categoria', slug: 'categoria' }
      if (args.collection === 'portal-page-media') return null
      if (args.collection !== 'portal-pages') return null
      return copy(current.pages.get(String(args.id)) || null)
    },
    findVersions: async (args: Record<string, unknown>) => {
      call('findVersions', args)
      const current = stateFor(args.req as { transactionID?: unknown })
      const where = args.where as { and?: Array<Record<string, Record<string, unknown>>> } | undefined
      let rows = [...current.versions.values()]
      for (const condition of where?.and || []) {
        if (condition.parent?.equals !== undefined) rows = rows.filter(row => row.parent === condition.parent!.equals)
        if (condition.latest?.equals !== undefined) rows = rows.filter(row => row.latest === condition.latest!.equals)
        if (condition.autosave?.equals !== undefined) rows = rows.filter(row => row.autosave === condition.autosave!.equals)
      }
      rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.id).localeCompare(String(a.id)))
      const limit = Number(args.limit || rows.length)
      return { docs: copy(rows.slice(0, limit)), hasNextPage: rows.length > limit }
    },
    findVersionByID: async (args: Record<string, unknown>) => {
      call('findVersionByID', args)
      return copy(state.versions.get(String(args.id)) || null)
    },
    create: async (args: Record<string, unknown>) => {
      call('create', args)
      const current = stateFor(args.req as { transactionID?: unknown })
      const id = nextID()
      const data = copy(args.data as Record<string, unknown>)
      const author = (args.req as PayloadRequest | undefined)?.user as Record<string, unknown> | undefined
      data.createdBy = author?.portalUid || 'editor-uid'
      data.updatedBy = author?.portalUid || 'editor-uid'
      data.publishedAt = null
      const savedAt = new Date(++clock).toISOString()
      const page = { ...data, id, _status: 'draft', updatedAt: savedAt, createdAt: savedAt }
      current.pages.set(id, page)
      const row = { id: nextID(), parent: id, latest: true, autosave: false, updatedAt: savedAt,
        createdAt: savedAt, createdBy: data.createdBy, updatedBy: data.updatedBy,
        version: copy(page) }
      current.versions.set(String(row.id), row)
      return copy(page)
    },
    update: async (args: Record<string, unknown>) => {
      call('update', args)
      const current = stateFor(args.req as { transactionID?: unknown })
      const id = String(args.id)
      const page = current.pages.get(id)
      if (!page) throw Object.assign(new Error('portal_page_not_found'), { status: 404 })
      const data = copy(args.data as Record<string, unknown>)
      const author = (args.req as PayloadRequest | undefined)?.user as Record<string, unknown> | undefined
      data.createdBy = page.createdBy || author?.portalUid || 'editor-uid'
      data.updatedBy = author?.portalUid || 'editor-uid'
      const status = data._status === 'published' ? 'published' : 'draft'
      data.publishedAt = status === 'published' ? new Date(++clock).toISOString()
        : args.draft === true ? page.publishedAt ?? null : null
      const savedAt = new Date(++clock).toISOString()
      const updatedPage = { ...page, ...data, id, _status: status, updatedAt: savedAt }
      if (args.draft !== true) current.pages.set(id, updatedPage)
      for (const row of current.versions.values()) if (row.parent === id && row.latest === true) row.latest = false
      const row = { id: nextID(), parent: id, latest: true, autosave: false, updatedAt: savedAt,
        createdAt: savedAt, createdBy: data.createdBy, updatedBy: data.updatedBy, version: copy(updatedPage) }
      current.versions.set(String(row.id), row)
      return copy(updatedPage)
    },
  }
  const req = { payload, transactionID: undefined, context: {}, user: {
    id: 'editor-1', collection: 'portal-editors', portalUid: 'editor-uid',
    adminActor: { version: 2, uid: 'editor-uid', email: 'editor@example.test', name: 'Editor',
      capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false } },
    adminExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, i18n: { t: (key: string) => key }, t: (key: string) => key } as unknown as PayloadRequest

  return {
    req, calls,
    seedLatest(record: Record<string, unknown>) {
      const row = copy(record)
      const id = String(row.parent)
      if (!state.pages.has(id)) state.pages.set(id, { id, title: 'Principal', slug: 'principal', summary: '', cover: null,
        coverAlt: null, categories: [], body: [], _status: 'published', publishedAt: '2026-10-18T00:00:00.000Z',
        createdBy: 'creator', updatedBy: 'editor-uid' })
      for (const existing of state.versions.values()) if (existing.parent === id && existing.latest === true) existing.latest = false
      state.versions.set(String(row.id), row)
    },
    seedVersion(record: Record<string, unknown>) {
      const row = copy(record)
      const id = String(row.parent)
      if (!state.pages.has(id)) state.pages.set(id, { id, title: 'Principal', slug: 'principal', summary: '', cover: null,
        coverAlt: null, categories: [], body: [], _status: 'published', publishedAt: '2026-10-18T00:00:00.000Z',
        createdBy: 'creator', updatedBy: 'editor-uid' })
      state.versions.set(String(row.id), row)
    },
    seedPage(record: Record<string, unknown>) { state.pages.set(String(record.id), copy(record)) },
    corruptReceipt(field: NonNullable<typeof receiptCorruption>) { receiptCorruption = field },
    loseCommit() { lostCommit = true },
    addVersionAfterCommit() { versionAfterCommit = true },
  }
}
