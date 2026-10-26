import assert from 'node:assert/strict'
import test from 'node:test'

async function manualConfig() {
  const previous = { buildOnly: process.env.CMS_BUILD_ONLY, phase: process.env.NEXT_PHASE }
  try {
    process.env.CMS_BUILD_ONLY = 'true'
    process.env.NEXT_PHASE = 'phase-production-build'
    return await (await import('../../src/payload.config.js')).default
  } finally {
    if (previous.buildOnly === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = previous.buildOnly
    if (previous.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = previous.phase
  }
}

test('manual profile omits schedule UI, collection, endpoints and publication jobs', async () => {
  const config = await manualConfig()
  assert.equal(config.collections.some(collection => collection.slug === 'news-schedules'), false)
  assert.equal(config.endpoints.some(endpoint => endpoint.path === '/news-schedule'), false)
  assert.deepEqual(config.jobs?.tasks, [])

  const articles = config.collections.find(collection => collection.slug === 'news-articles')!
  const articleControls = articles.admin?.components?.edit?.beforeDocumentControls || []
  assert.equal(articleControls.some(component => String(component).includes('ScheduleRevision')), false)
  assert.equal(articles.versions && typeof articles.versions === 'object' &&
    typeof articles.versions.drafts === 'object' && articles.versions.drafts.autosave, false)

  const home = config.globals.find(global => global.slug === 'news-home')!
  const homeControls = home.admin?.components?.elements?.beforeDocumentControls || []
  assert.equal(homeControls.some(component => String(component).includes('ScheduleRevision')), false)
  assert.equal(home.versions && typeof home.versions === 'object' &&
    typeof home.versions.drafts === 'object' && home.versions.drafts.autosave, false)
})

test('manual profile preserves explicit draft and publish support', async () => {
  const config = await manualConfig()
  const articles = config.collections.find(collection => collection.slug === 'news-articles')!
  assert.ok(articles.versions && typeof articles.versions === 'object' && articles.versions.drafts)
  assert.equal(articles.access.create instanceof Function, true)
  assert.equal(articles.access.update instanceof Function, true)
})
