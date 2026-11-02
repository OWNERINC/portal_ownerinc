import { APIError, type CollectionBeforeOperationHook, type GlobalBeforeOperationHook } from 'payload'
import { editorialBoundary, type EditorialProfile } from '../config/editorial-profile'

type Intent = { data?: Record<string, unknown>; draft?: boolean; autosave?: boolean; publishAllLocales?: boolean;
  unpublishAllLocales?: boolean; publishSpecificLocale?: string }

const booleanControls = ['draft', 'autosave', 'publishAllLocales', 'unpublishAllLocales'] as const
// qs-esm accepts a root [name] without a parent and ignores text after its
// closing bracket: [draft]suffix, [draft]] and [draft][ all mean draft. Include
// incomplete/nested root-bracket spellings in the rejected noncanonical family.
const controlName = /^\[*(?:draft|autosave|publishAllLocales|unpublishAllLocales|publishSpecificLocale)(?:$|\[|\]|\.)/u

/** 3.90.2 collection parseParams drops arrays/unknown booleans; Home uses .get
 * (first duplicate). Inspect the untouched URL before either lossy conversion.
 * Native UI submits only the exact strings true/false for these controls.
 * The caller establishes the News target. Known operation hooks must never
 * reclassify it using req.url (Next's resolved dispatch path may differ). */
export function assertRawNewsDraftControls(request: Partial<Pick<Request, 'url'>>, parsed?: Intent) {
  if (!request.url) throw new APIError('news_draft_intent_invalid', 400)
  const url = new URL(request.url)
  for (const [key, value] of url.searchParams) {
    if (!controlName.test(key)) continue
    if (!booleanControls.includes(key as typeof booleanControls[number]) || url.searchParams.getAll(key).length !== 1 ||
      !['true', 'false'].includes(value)) throw new APIError('news_draft_intent_invalid', 400)
    // Also refuse valid raw controls lost to parser limits or other coercion.
    if (parsed && parsed[key as typeof booleanControls[number]] !== (value === 'true')) throw new APIError('news_draft_intent_invalid', 400)
  }
}

/** Runs before the native operation computes isSavingDraft (beforeChange is too late). */
export function normalizeDraftIntent(args: Intent, profile: EditorialProfile) {
  for (const key of ['draft', 'autosave', 'publishAllLocales', 'unpublishAllLocales'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new APIError('news_draft_intent_invalid', 400)
  }
  if (args.publishSpecificLocale || args.publishAllLocales === true) throw new APIError('news_draft_intent_invalid', 400)
  if (args.autosave && profile !== 'editorial-v1') throw new APIError('news_autosave_unavailable', 403)
  const data = args.data ?? {}
  if (args.autosave || args.draft || data._status === undefined) {
    if (args.unpublishAllLocales) throw new APIError('news_draft_intent_invalid', 400)
    args.draft = true
    args.data = { ...data, _status: 'draft' }
  } else if (typeof data._status !== 'string' || !['draft', 'published'].includes(data._status)) throw new APIError('news_draft_intent_invalid', 400)
  return args
}

export function createArticleDraftIntent(profile: EditorialProfile): CollectionBeforeOperationHook {
  return editorialBoundary(({ args, operation, req }) => {
    if (operation === 'create' || operation === 'update') {
      if (req.payloadAPI === 'REST') assertRawNewsDraftControls(req, args)
      normalizeDraftIntent(args, profile)
    }
    return args
  }, profile, 'draft')
}
export function createHomeDraftIntent(profile: EditorialProfile): GlobalBeforeOperationHook {
  return editorialBoundary(({ args, operation, req }) => {
    if (operation === 'update') {
      if (req.payloadAPI === 'REST') assertRawNewsDraftControls(req, args)
      normalizeDraftIntent(args, profile)
    }
    return args
  }, profile, 'draft')
}
