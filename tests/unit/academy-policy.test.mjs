import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { hasCourseAudience, canReadCourse } = require('../../api/academy/access');
const { parseYouTubeId, normalizeMedia, validateCourseInput, validateLessonInput } = require('../../api/academy/validation');
const { AcademyError } = require('../../api/academy/errors');
const { readProgress, summarizeProgress } = require('../../api/academy/progress');
const jobId = 'abcdef12-3456-4789-abcd-012345678901';
const youtubeUrl = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
const internal = { title: 'Formação', delivery_mode: 'internal' };
const lesson = { title: 'Aula', media: { type: 'youtube', url: youtubeUrl } };

test('audiência usa cargo profissional ativo, nunca role ou grupo visual', () => {
  const course = { active: true, audience: 'job_titles', learning_group: 'initial' };
  const user = { role: 'viewer', job_title_id: jobId, job_title_active: true };
  assert.equal(canReadCourse(user, course, [jobId]), true);
  for (const other of [null, { ...user, job_title_active: false },
    { ...user, job_title_active: 'true' }, { ...user, job_title_id: 'other' },
    { role: 'admin', permissions: { superAdmin: true } }]) {
    assert.equal(canReadCourse(other, course, [jobId]), false);
  }
  assert.equal(hasCourseAudience(user, { audience: 'all' }), true);
  assert.equal(hasCourseAudience(null, { audience: 'all' }), false);
  assert.equal(hasCourseAudience(user, { audience: 'unknown' }, [jobId]), false);
  assert.equal(hasCourseAudience(user, course, null), false);
  assert.equal(hasCourseAudience({ job_title_active: true }, course, [undefined]), false);
  assert.equal(canReadCourse(user, { ...course, active: false }, [jobId]), false);
});

test('preview é explícito e exige can(manageAcademy)', () => {
  const course = { active: false, audience: 'job_titles' };
  const manager = { role: 'admin', permissions: { manageAcademy: true } };
  assert.equal(canReadCourse(manager, course, []), false);
  assert.equal(canReadCourse(manager, course, [], { preview: true }), true);
  for (const user of [null, { role: 'admin', permissions: {} },
    { role: 'viewer', permissions: { manageAcademy: true } }]) {
    assert.equal(canReadCourse(user, course, [], { preview: true }), false);
  }
  assert.equal(canReadCourse(manager, null, [], { preview: true }), false);
  assert.equal(canReadCourse(manager, course, [], { preview: 'true' }), false);
});

test('YouTube aceita hosts e formatos exatos e normaliza a identidade', () => {
  for (const url of [youtubeUrl, 'https://youtube.com/watch?v=M7lc1UVf-VE&list=PL1',
    'https://youtu.be/M7lc1UVf-VE?t=12', 'https://m.youtube.com/shorts/M7lc1UVf-VE',
    'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE',
    'https://www.youtube.com:443/embed/M7lc1UVf-VE']) {
    assert.equal(parseYouTubeId(url), 'M7lc1UVf-VE');
    assert.deepEqual(normalizeMedia({ type: 'youtube', url }), { type: 'youtube', video_id: 'M7lc1UVf-VE' });
  }
});

test('YouTube rejeita origem, protocolo, credenciais, caminho e ID inválidos', () => {
  for (const url of [null, {}, '', 'M7lc1UVf-VE', 'javascript:alert(1)',
    'http://youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE',
    'https://name:pass@youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com:444/watch?v=M7lc1UVf-VE',
    'https://youtube.com/playlist?list=PL123', 'https://youtube.com/watch?v=short',
    'https://youtube.com/embed/M7lc1UVf-VE/extra', 'https://youtu.be/extra/M7lc1UVf-VE',
    `${youtubeUrl}&x=${'a'.repeat(2048)}`]) assert.equal(parseYouTubeId(url), null);
});

test('arquivo direto HTTPS aceita MP4/WebM e query; não aceita outros tipos', () => {
  for (const url of ['https://media.example/a.mp4?token=abc', 'https://media.example/a.WEBM']) {
    assert.deepEqual(normalizeMedia({ type: 'file', url }), { type: 'file', url });
  }
  for (const url of ['http://media.example/a.mp4', 'https://u:p@media.example/a.mp4',
    'https://media.example/video', 'https://media.example/video?name=a.mp4',
    'https://media.example/a.mp4/extra', 'https://media.example/a.mov',
    `https://media.example/a.mp4?x=${'a'.repeat(2048)}`]) {
    assert.equal(normalizeMedia({ type: 'file', url }), null);
  }
  for (const value of [null, [], {}, { type: 'vimeo', url: youtubeUrl },
    { type: 'youtube', url: youtubeUrl, uid: 'injected' },
    { type: 'youtube', video_id: 'M7lc1UVf-VE' }]) assert.equal(normalizeMedia(value), null);
});

test('arquivo direto limita também URL normalizada após expansão Unicode', () => {
  const expanded = `https://media.example/${'é'.repeat(400)}.mp4`;
  assert.ok(expanded.length < 2048);
  assert.ok(new URL(expanded).href.length > 2048);
  assert.equal(normalizeMedia({ type: 'file', url: expanded }), null);
  assert.equal(validateLessonInput({ ...lesson, media: { type: 'file', url: expanded } }), null);

  const prefix = 'https://media.example/é';
  const boundary = `${prefix}${'a'.repeat(2048 - new URL(prefix).href.length - '.mp4'.length)}.mp4`;
  assert.equal(new URL(boundary).href.length, 2048);
  assert.deepEqual(normalizeMedia({ type: 'file', url: boundary }), { type: 'file', url: new URL(boundary).href });
  assert.ok(validateLessonInput({ ...lesson, media: { type: 'file', url: boundary } }));
  const overBoundary = boundary.replace('.mp4', 'a.mp4');
  assert.ok(overBoundary.length < 2048);
  assert.equal(new URL(overBoundary).href.length, 2049);
  assert.equal(normalizeMedia({ type: 'file', url: overBoundary }), null);
  assert.equal(validateLessonInput({ ...lesson, media: { type: 'file', url: overBoundary } }), null);
});

test('curso novo interno tem defaults explícitos e externo mantém URL HTTP(S)', () => {
  assert.deepEqual(validateCourseInput(internal), {
    title: 'Formação', category: '', description: '', url: null, order: 0, active: false,
    delivery_mode: 'internal', audience: 'all', learning_group: 'initial',
    icon_key: 'icon-01', instructor_name: '', job_title_ids: [],
  });
  const external = validateCourseInput({ title: ' Legado ', url: 'http://example.com/course' });
  assert.equal(external.title, 'Legado');
  assert.equal(external.delivery_mode, 'external');
  assert.equal(external.active, false);
  assert.equal(validateCourseInput({ title: 'Sem URL' }), null);
  assert.equal(validateCourseInput({ ...internal, url: 'https://example.com' }), null);
});

test('edição legada preserva novos campos atuais sem vazar metadados', () => {
  const current = { ...validateCourseInput(internal), id: jobId, media_version: 9,
    audience: 'job_titles', job_title_ids: [jobId], learning_group: 'role',
    icon_key: 'icon-06', instructor_name: 'Professora', active: true };
  const result = validateCourseInput({ title: 'Novo título', description: 'Revisão' }, current);
  assert.deepEqual(result, { ...validateCourseInput(internal), title: 'Novo título',
    description: 'Revisão', audience: 'job_titles', job_title_ids: [jobId],
    learning_group: 'role', icon_key: 'icon-06', instructor_name: 'Professora', active: true });
  assert.equal(current.title, 'Formação');
  const converted = validateCourseInput({ delivery_mode: 'internal' },
    { title: 'Legado', url: 'https://example.com', active: true });
  assert.equal(converted.url, null);
});

test('cargos exigem UUIDs únicos (inclusive caixa), no máximo 100 e público restrito não vazio', () => {
  assert.equal(validateCourseInput({ ...internal, audience: 'job_titles' }), null);
  for (const ids of [[jobId, jobId], [jobId, jobId.toUpperCase()], ['closer'], null,
    Array.from({ length: 101 }, (_, i) => `abcdef12-3456-4789-abcd-${String(i).padStart(12, '0')}`)]) {
    assert.equal(validateCourseInput({ ...internal, job_title_ids: ids }), null);
  }
  const ids = Array.from({ length: 100 }, (_, i) => `abcdef12-3456-4789-abcd-${String(i).padStart(12, '0')}`);
  assert.equal(validateCourseInput({ ...internal, audience: 'job_titles', job_title_ids: ids }).job_title_ids.length, 100);
  assert.deepEqual(validateCourseInput({ ...internal, job_title_ids: [jobId.toUpperCase()] }).job_title_ids, [jobId]);
});

test('curso aplica limites inclusive ao ativar e rejeita enums e campos extras', () => {
  for (const [field, max] of [['title', 200], ['category', 100], ['description', 5000], ['instructor_name', 120]]) {
    assert.ok(validateCourseInput({ ...internal, [field]: 'a'.repeat(max) }));
    assert.equal(validateCourseInput({ ...internal, active: true, [field]: 'a'.repeat(max + 1) }), null);
  }
  for (const bad of [{ title: '  ' }, { active: 'true' }, { order: 1.5 }, { order: 100001 },
    { order: -100001 }, { delivery_mode: 'unknown' }, { audience: 'role' },
    { learning_group: 'all' }, { icon_key: 'icon-07' }, { uid: 'x' }, { user_uid: 'x' },
    { media_version: 2 }, { id: jobId }, { constructor: 'x' }, { extra: true }]) {
    assert.equal(validateCourseInput({ ...internal, ...bad }), null);
  }
  assert.ok(validateCourseInput({ ...internal, order: -100000 }));
  assert.ok(validateCourseInput({ ...internal, order: 100000 }));
  for (const value of [null, [], 'input']) assert.equal(validateCourseInput(value), null);
});

test('aula exige título e mídia, defaults inativos e whitelist estrita', () => {
  assert.deepEqual(validateLessonInput(lesson), { title: 'Aula', description: '', order: 0,
    active: false, media: { type: 'youtube', video_id: 'M7lc1UVf-VE' } });
  for (const body of [null, [], {}, { title: 'Aula' }, { media: lesson.media },
    { ...lesson, title: ' ' }, { ...lesson, title: 'x'.repeat(201) },
    { ...lesson, description: 'x'.repeat(5001) }, { ...lesson, order: 0.5 },
    { ...lesson, order: -100001 }, { ...lesson, order: 100001 },
    { ...lesson, active: 1 }, { ...lesson, active: true, media: { type: 'file', url: 'bad' } }]) {
    assert.equal(validateLessonInput(body), null);
  }
  for (const field of ['uid', 'user_uid', 'id', 'module_id', 'media_version', 'constructor', 'extra']) {
    assert.equal(validateLessonInput({ ...lesson, [field]: 'x' }), null);
  }
  assert.ok(validateLessonInput({ ...lesson, title: 'x'.repeat(200), description: 'x'.repeat(5000), order: 100000, active: true }));
});

test('AcademyError expõe status e reason para a camada HTTP', () => {
  const error = new AcademyError(404, 'course_not_found');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AcademyError');
  assert.equal(error.status, 404);
  assert.equal(error.reason, 'course_not_found');
  assert.equal(error.message, 'course_not_found');
});

test('resumo ignora aulas ocultas e versões antigas e usa apenas aulas fornecidas', () => {
  const lessons = [{ id: 'a', media_version: 2 }, { id: 'b', media_version: 1 }];
  assert.deepEqual(summarizeProgress(lessons, [
    { lesson_id: 'a', media_version: 1, completed: true },
    { lesson_id: 'b', media_version: 1, completed: true },
    { lesson_id: 'hidden', media_version: 1, completed: true },
  ]), { total_lessons: 2, completed_lessons: 1, progress_percent: 50, resume_lesson_id: 'a' });
  assert.deepEqual(summarizeProgress([], []), {
    total_lessons: 0, completed_lessons: 0, progress_percent: 0, resume_lesson_id: null,
  });
  assert.equal(summarizeProgress(lessons, []).resume_lesson_id, null);
  assert.equal(summarizeProgress(lessons, [{ lesson_id: 'a', media_version: 1 }]).resume_lesson_id, null);
});

test('retomada prioriza incompleta recente, desempata por ordem e conclusão é manual', () => {
  const lessons = ['a', 'b', 'c'].map(id => ({ id, media_version: 1 }));
  const rows = [
    { lesson_id: 'a', media_version: 1, completed: false, updated_at: '2026-09-30T10:00:00Z' },
    { lesson_id: 'b', media_version: 1, completed: false, position_seconds: 86400, updated_at: '2026-09-30T11:00:00Z' },
    { lesson_id: 'c', media_version: 1, completed: true, updated_at: '2026-09-30T12:00:00Z' },
  ];
  const before = structuredClone({ lessons, rows });
  assert.deepEqual(summarizeProgress(lessons, rows), {
    total_lessons: 3, completed_lessons: 1, progress_percent: 33, resume_lesson_id: 'b',
  });
  assert.deepEqual({ lessons, rows }, before);
  assert.equal(summarizeProgress(lessons, rows.map(row => ({ ...row, updated_at: rows[0].updated_at }))).resume_lesson_id, 'a');
  assert.deepEqual(summarizeProgress(lessons, rows.map(row => ({ ...row, completed: true }))), {
    total_lessons: 3, completed_lessons: 3, progress_percent: 100, resume_lesson_id: null,
  });
});

test('leitura isola usuário/aula/versão por parâmetros e ausência é progresso zero', async () => {
  const queries = [];
  const pool = { query: async (sql, values) => { queries.push({ sql, values }); return { rows: [] }; } };
  assert.deepEqual(await readProgress(pool, 'user-A', jobId, 2), {
    lesson_id: jobId, media_version: 2, position_seconds: 0,
    completed: false, completed_at: null, version: 0, updated_at: null,
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /^SELECT\s/);
  assert.match(queries[0].sql, /WHERE user_uid=\$1 AND lesson_id=\$2 AND media_version=\$3/);
  assert.deepEqual(queries[0].values, ['user-A', jobId, 2]);
  const row = { lesson_id: jobId, media_version: 2, position_seconds: 10,
    completed: false, completed_at: null, version: 3, updated_at: '2026-09-30T12:00:00Z' };
  assert.deepEqual(await readProgress({ query: async () => ({ rows: [row] }) }, 'user-A', jobId, 2), row);
  await assert.rejects(readProgress({ query: async () => { throw new Error('db unavailable'); } }, 'user-A', jobId, 2), /db unavailable/);
});
