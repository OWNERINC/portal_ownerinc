import { createHash } from 'node:crypto'
import { APIError, type CollectionConfig, type GlobalConfig, type Endpoint, type SanitizedConfig } from 'payload'
import { canonicalJSON } from '../publication/snapshot-hash.mjs'

export type EditorialProfile = 'held-v1' | 'editorial-v1'
export function readEditorialProfile(value: unknown): EditorialProfile {
  if (value === undefined) return 'held-v1'
  if (value !== 'held-v1' && value !== 'editorial-v1') throw new Error('Invalid CMS_EDITORIAL_PROFILE')
  return value
}
export function editorialProfileDescriptor(profile: EditorialProfile) {
  readEditorialProfile(profile)
  const active = profile === 'editorial-v1'
  return Object.freeze({ descriptorVersion: 1 as const, profileId: profile, publicationMode: 'manual' as const,
    payloadVersion: '3.90.2' as const,
    articles: Object.freeze({ drafts: true, autosave: active ? 1500 : false, maxPerDoc: 0 }),
    home: Object.freeze({ drafts: true, autosave: active ? 1500 : false, max: 0 }),
    history: active ? 'current-news-editor-v1' : 'deny',
    articleRestore: active ? 'native-new-draft-v1' : 'deny',
    homeRestore: active ? 'update-global-new-draft-v1' : 'deny',
    schedulePublish: false, scheduleEndpoints: false, worker: false,
    publicationTasks: Object.freeze([]), autoRun: Object.freeze([]) })
}
export type EditorialDescriptor = ReturnType<typeof editorialProfileDescriptor>
export const editorialProfileHash = (descriptor: EditorialDescriptor): string => createHash('sha256')
  .update(`ownerinc.cms.editorial-profile.v1\n${canonicalJSON(descriptor)}`).digest('hex')

type Boundary = 'history' | 'draft' | 'restore'
const boundaries = new WeakMap<object, { profile: EditorialProfile; kind: Boundary }>()
export function editorialBoundary<T extends object>(callback: T, profile: EditorialProfile, kind: Boundary): T {
  boundaries.set(callback, { profile, kind }); return callback
}
const boundaryMatches = (callback: unknown, profile: EditorialProfile, kind: Boundary) => {
  const marker = typeof callback === 'function' ? boundaries.get(callback) : undefined
  return marker?.profile === profile && marker.kind === kind
}
const fail = (): never => { throw new APIError('cms_editorial_profile_incompatible', 503, undefined, true) }
const sameCallbacks = (actual: unknown[], expected: unknown[]) => actual.length === expected.length && actual.every((hook, index) => hook === expected[index])
type Safety = { slug: string; update: unknown; create: unknown; delete: unknown; beforeOperation: unknown[]; beforeChange: unknown[]; afterChange: unknown[] }
const safety = new WeakMap<object, Safety>()
const restoreEndpoints = new WeakMap<Endpoint['handler'], Endpoint['method']>()
/** Record the factory's exact server callbacks before Payload sanitizes/clones the
 * config. Keep this registry dependency-light: auth also imports profile parsing. */
export function registerEditorialSafety<T extends CollectionConfig | GlobalConfig>(entity: T): T {
  const access = entity.access as CollectionConfig['access']
  if (!access?.readVersions) return fail()
  safety.set(access.readVersions, { slug: entity.slug, update: access.update, create: access.create, delete: access.delete,
    beforeOperation: [...entity.hooks?.beforeOperation || []], beforeChange: [...entity.hooks?.beforeChange || []], afterChange: [...entity.hooks?.afterChange || []] })
  return entity
}
export function registerRestoreEndpoint(method: Endpoint['method'], handler: Endpoint['handler']) {
  restoreEndpoints.set(handler, method); return handler
}

/** Evidence of the loaded config, not authorization to promote it. */
export function assertEditorialProfile(config: SanitizedConfig) {
  const stored = config.custom?.editorialProfile as EditorialDescriptor | undefined
  if (!stored || !['held-v1', 'editorial-v1'].includes(stored.profileId)) return fail()
  const profile = stored.profileId, descriptor = editorialProfileDescriptor(profile)
  if (canonicalJSON(stored) !== canonicalJSON(descriptor)) return fail()
  const article = config.collections.find(item => item.slug === 'news-articles')
  const home = config.globals.find(item => item.slug === 'news-home')
  if (!article || !home || !article.versions || !home.versions || article.versions.maxPerDoc !== 0 || home.versions.max !== 0) return fail()
  for (const entity of [article, home]) {
    const drafts = entity.versions && entity.versions.drafts
    const registered = safety.get(entity.access.readVersions)
    if (!drafts || drafts.schedulePublish !== false ||
      (profile === 'held-v1' ? drafts.autosave !== false : !drafts.autosave || drafts.autosave.interval !== 1500) ||
      !boundaryMatches(entity.access.readVersions, profile, 'history') ||
      !boundaryMatches(entity.hooks.beforeOperation[0], profile, 'restore') ||
      !boundaryMatches(entity.hooks.beforeOperation[1], profile, 'draft') ||
      !registered || registered.slug !== entity.slug || registered.update !== entity.access.update ||
      !sameCallbacks(entity.hooks.beforeOperation, registered.beforeOperation) ||
      !sameCallbacks(entity.hooks.beforeChange, registered.beforeChange) ||
      !sameCallbacks(entity.hooks.afterChange, registered.afterChange) ||
      entity.lockDocuments === false || drafts.validate === true ||
      entity.admin.components?.views?.edit?.version?.Component !== '/admin/NewsVersionView#NewsVersionView') return fail()
  }
  const articleSafety = safety.get(article.access.readVersions)!
  if (article.access.create !== articleSafety.create || article.access.delete !== articleSafety.delete || article.disableBulkEdit !== true ||
    !article.admin.components?.edit?.beforeDocumentControls?.includes('/admin/SaveDraftCheckpoint#SaveDraftCheckpoint') ||
    !home.admin.components?.elements?.beforeDocumentControls?.includes('/admin/SaveDraftCheckpoint#SaveDraftCheckpoint')) return fail()
  if (config.collections.some(item => item.slug === 'news-schedules') ||
    config.endpoints.some(item => item.path.startsWith('/news-schedule')) ||
    (['get', 'post'] as const).some(method => {
      const matches = config.endpoints.filter(item => item.path === '/news-restore-draft' && item.method === method)
      return matches.length !== 1 || restoreEndpoints.get(matches[0].handler) !== method
    }) ||
    !Array.isArray(config.jobs.tasks) || config.jobs.tasks.length || !Array.isArray(config.jobs.autoRun) || config.jobs.autoRun.length || config.jobs.workflows?.length ||
    config.localization || !config.graphQL.disable) return fail()
  return { id: profile, sha256: editorialProfileHash(descriptor), descriptor }
}

export function configuredEditorialProfile(config: SanitizedConfig): EditorialProfile {
  const value = config.custom?.editorialProfile?.profileId
  if (value !== 'held-v1' && value !== 'editorial-v1') return fail()
  return value
}
