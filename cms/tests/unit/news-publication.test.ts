import assert from 'node:assert/strict'
import test from 'node:test'
import { canRunSchedule } from '../../src/publication/schedule.js'
import { snapshotHash } from '../../src/publication/document.js'
import { scheduleBlocked, scheduleUTC, SCHEDULE_TIMEZONE } from '../../src/admin/schedule-state.js'
import { APIError, ValidationError } from 'payload'
import { isNativeContentValidation } from '../../src/publication/validation.js'

test('despublicação invalida uma execução já retirada da fila', () => {
  assert.equal(canRunSchedule({ state: 'pending', generation: 4 }, 5), false)
  assert.equal(canRunSchedule({ state: 'pending', generation: 5 }, 5), true)
  assert.equal(canRunSchedule({ state: 'published', generation: 5 }, 5), false)
})

test('snapshot hash survives PostgreSQL JSONB key ordering, but covers every nested value', () => {
  const snapshot = { title: 'A', category: 'C', editorial: { summary: 'S', author: 'Author' }, body: [{ blockType: 'paragraph', text: 'Body' }] }
  const reordered = { body: snapshot.body, editorial: { author: 'Author', summary: 'S' }, category: 'C', title: 'A' }
  assert.equal(snapshotHash(snapshot), snapshotHash(reordered))
  for (const field of ['title', 'category', 'editorial', 'body']) assert.notEqual(snapshotHash(snapshot), snapshotHash({ ...snapshot, [field]: null }))
})

test('native control gates modified, save, autosave, initializing, upload, lock and other media drawers independently', () => {
  const idle = { modified: false, processing: false, backgroundProcessing: false, initializing: false, disabled: false, uploading: false, otherModalOpen: false, busy: false }
  assert.equal(scheduleBlocked(idle), false)
  for (const flag of Object.keys(idle)) assert.equal(scheduleBlocked({ ...idle, [flag]: true }), true, flag)
})

test('civil scheduling is America/Sao_Paulo, independent of machine/browser timezone; malformed civil dates refuse', () => {
  assert.equal(SCHEDULE_TIMEZONE, 'America/Sao_Paulo')
  assert.equal(scheduleUTC('2030-01-02 10:30'), '2030-01-02T13:30:00.000Z')
  for (const value of ['', '2030-02-30 10:30', '2030-13-01 10:30', '2030-01-01 24:00', '2030-01-01T10:30Z']) assert.throws(() => scheduleUTC(value))
})

test('only native authored-field validation is deterministic; DB-translated constraints/audit/API failures propagate', () => {
  const native = new ValidationError({ collection: 'news-articles', errors: [{ path: 'body.0.title', message: 'too long' }] })
  assert.equal(isNativeContentValidation(native, 'news-articles'), true)
  assert.equal(isNativeContentValidation(native, 'news-home'), false)
  const home = new ValidationError({ global: 'news-home', errors: [{ path: 'headline', message: 'too long' }] })
  assert.equal(isNativeContentValidation(home, 'news-home'), true)
  for (const error of [new Error('connection lost'), new APIError('invalid', 400),
    new ValidationError({ collection: 'news-audit', errors: [{ path: 'actorUid', message: 'invalid' }] }),
    new ValidationError({ collection: 'news-articles', errors: [{ path: 'title', message: 'unique', tableName: 'news_articles' }] }),
    new ValidationError({ collection: 'news-articles', errors: [{ path: 'id', message: 'invalid' }] }),
    new ValidationError({ collection: 'news-articles', errors: [] })]) {
    assert.equal(isNativeContentValidation(error, 'news-articles'), false)
  }
})
