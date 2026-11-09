import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';
import { academyHarness, course, courseData, lessonData } from '../helpers/academy-frontend.mjs';

test('dashboard resumes the real lesson, renders safe text and progress with an official brand fallback', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/reminders/upcoming').resolve([]);
  h.latest('/api/academy/continue?').resolve([course('course-a', {
    title: '<script>Curso seguro</script>', resume_lesson_id: 'lesson-a', completed_lessons: 1, total_lessons: 2,
  })]);
  await drain();
  const preview = h.node('academy-preview');
  assert.match(preview.textContent, /<script>Curso seguro<\/script>/);
  assert.equal(preview.querySelectorAll('script').length, 0);
  assert.equal(preview.querySelector('a').getAttribute('href'), './academy.html?course=course-a&lesson=lesson-a');
  assert.equal(preview.querySelector('progress').getAttribute('value'), '1');
  assert.equal(preview.querySelector('progress').getAttribute('max'), '2');
  assert.equal(preview.querySelector('img').getAttribute('src'), './assets/academy/icon-02.svg');
  assert.equal(h.requests.some(request => request.path.includes('/api/academy?')), false);
});

test('dashboard offers real catalog content only after an empty continuation and ignores a superseded fallback', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/reminders/upcoming').resolve([]);
  h.latest('/api/academy/continue?').resolve([]);
  await drain();
  const old = h.latest('/api/academy?');
  assert.equal(old.path, '/api/academy?active=true&limit=1');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/api/academy/continue?').resolve([course('fresh', { title: 'Retomada atual', resume_lesson_id: 'lesson-b' })]);
  await drain();
  old.resolve([course('stale', { title: 'Catálogo antigo' })]);
  await drain();
  assert.match(h.node('academy-preview').textContent, /Retomada atual/);
  assert.doesNotMatch(h.node('academy-preview').textContent, /Catálogo antigo/);
  assert.equal(h.node('academy-heading').textContent, 'Continue de onde parou');
});

test('dashboard catalog fallback gives an honest start action and safe external URLs', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/academy/continue?').resolve([]);
  await drain();
  h.latest('/api/academy?').resolve([course('external', { delivery_mode: 'external', url: 'javascript:alert(1)', icon_key: '../../bad' })]);
  await drain();
  assert.equal(h.node('academy-heading').textContent, 'Comece a aprender');
  assert.equal(h.node('academy-preview').querySelector('a').getAttribute('href'), './academy.html');
  assert.equal(h.node('academy-preview').querySelector('img').getAttribute('src'), './assets/academy/symbol.svg');
  assert.equal(h.node('academy-preview').querySelectorAll('progress').length, 0);
});

test('dashboard retry restores its removed control focus without stealing a later user interaction', async t => {
  for (const moved of [false, true]) {
    const h = await createFeedbackHarness('dashboard');
    t.after(() => h.page.dispose());
    h.latest('/api/academy/continue?').reject(new Error('offline'));
    await drain();
    const retry = h.node('academy-preview').querySelector('button');
    retry.focus(); retry.click();
    const other = h.node('quick-links').querySelector('a');
    if (moved) other.focus();
    h.latest('/api/academy/continue?').resolve([course()]);
    await drain();
    assert.equal(h.doc.activeElement, moved ? other : h.node('academy-preview').querySelector('a'));
  }
});

test('dashboard retry keeps a visible focus destination on empty and repeated error responses', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/academy/continue?').reject(new Error('offline'));
  await drain();
  const first = h.node('academy-preview').querySelector('button'); first.focus(); first.click();
  h.latest('/api/academy/continue?').reject(new Error('offline again'));
  await drain();
  const second = h.node('academy-preview').querySelector('button');
  assert.equal(h.doc.activeElement, second);
  second.click();
  h.latest('/api/academy/continue?').resolve([]);
  await drain();
  h.latest('/api/academy?').resolve([]);
  await drain();
  assert.equal(h.doc.activeElement, h.node('academy-preview').querySelector('[role="status"]'));
  const count = h.requests.length;
  h.page.dispose(); second.click();
  await drain();
  assert.equal(h.requests.length, count);
});

test('Academy continuation action targets the saved lesson and keeps catalog focus while its response arrives', async t => {
  const h = await academyHarness();
  t.after(() => h.page.dispose());
  await h.resolve('group=initial', { data: [], total: 0 });
  const select = h.doc.querySelector('#academy-filter-initial'); select.focus();
  await h.resolve('/continue?', [course('older', { resume_lesson_id: 'lesson-b', completed_lessons: 1 })]);
  assert.equal(h.doc.activeElement, select);
  assert.equal(h.link('Continuar curso').getAttribute('href'), './academy.html?course=older&lesson=lesson-b');
  const progress = h.root.querySelector('progress');
  assert.equal(progress.getAttribute('value'), '1');
  assert.equal(progress.getAttribute('max'), '2');
  h.link('Continuar curso').click(); await drain();
  assert.equal(h.location.searchParams.get('lesson'), 'lesson-b');
  await h.resolve('/api/academy/older', courseData('older'));
  await h.resolve('/lessons/lesson-b', lessonData('lesson-b', { course_id: 'older' }));
  assert.equal(h.doc.activeElement.tagName, 'H1');
});
