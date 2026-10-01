import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, manager, course, curriculum, cms, admin] = await Promise.all([
  readFile('public/academy/app.js', 'utf8'), readFile('public/academy/manage-view.js', 'utf8'),
  readFile('public/academy/course-editor.js', 'utf8'), readFile('public/academy/curriculum-editor.js', 'utf8'),
  readFile('public/js/cms.js', 'utf8'), readFile('public/js/admin.js', 'utf8'),
]);

test('Academy management is a permissioned route with dedicated editors and real API links', () => {
  assert.match(app, /mountAcademyManager/);
  assert.match(manager, /can\(page\?\.user, 'manageAcademy'\)/);
  assert.match(manager, /academy_lesson/);
  assert.match(manager, /source_id/);
  assert.match(course, /allowed_job_title_ids/);
  assert.match(course, /api\/academy\/job-titles\?limit=100/);
  assert.match(curriculum, /modules\/order/);
  assert.match(curriculum, /lessons\/order/);
  assert.match(curriculum, /controller\.abort/);
  assert.match(curriculum, /cms\.html\?type=academy_lesson&document=/);
  assert.match(admin, /academy\.html\?manage=1&course=/);
});

test('CMS lesson type and deep links remain type-scoped', () => {
  assert.match(cms, /\['academy_lesson', 'Academy — Aulas', 'manageAcademy'\]/);
  assert.match(cms, /academy_lesson: '\/api\/academy\/lessons\?all=true&limit=100&offset=0'/);
  assert.match(cms, /requestedTypeAllowed/);
  assert.match(cms, /doc\.content_type !== selectedType/);
});

test('management editors protect dirty and in-flight navigation', () => {
  assert.match(course, /page\.beforeLeave\(\(\) => !saving/);
  assert.match(curriculum, /page\.beforeLeave\(\(\) => !saving/);
  assert.match(manager, /curriculum\?\.dispose\(\)/);
  assert.match(manager, /view\.course \|\| view/);
  assert.match(manager, /delivery_mode === 'internal'/);
  assert.match(manager, /error\?\.status === 409/);
  assert.match(manager, /findExisting/);
});
