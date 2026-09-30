import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Controlled database boundary only: tests run the real routers, validators,
// mutations, CMS block validation and withAudit. Real SQL runs in test-academy.
export function mutationFixture() {
  const state = { courses: [], modules: [], lessons: [], audience: [], jobs: [], documents: [], revisions: [], assets: [], audits: [] };
  const calls = [];
  const users = {
    manager: { uid: 'manager', role: 'admin', permissions: { manageAcademy: true } },
    denied: { uid: 'denied', role: 'admin', permissions: {} },
  };
  let queue = Promise.resolve();
  let failAudit = false;
  let connection = 0;
  const pool = {
    async connect() {
      const clientId = ++connection;
      let unlock;
      let snapshot;
      let inTransaction = false;
      return {
        release() { assert.equal(inTransaction, false); },
        async query(raw, values = []) {
          const sql = raw.replace(/\s+/g, ' ').trim();
          calls.push({ sql, values, clientId });
          let rows = [];
          if (sql === 'BEGIN') { assert.equal(inTransaction, false); inTransaction = true; }
          else if (/pg_advisory_xact_lock/.test(sql)) {
            assert.equal(inTransaction, true);
            assert.deepEqual(values, [7193029]);
            if (!unlock) {
              const previous = queue;
              queue = new Promise(resolve => { unlock = resolve; });
              await previous;
              snapshot = structuredClone(state);
            }
          } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'ROLLBACK' && snapshot) Object.assign(state, snapshot);
            inTransaction = false;
            unlock?.(); unlock = null;
          } else if (/INSERT INTO audit_log/.test(sql)) {
            if (failAudit) throw new Error('audit unavailable');
            state.audits.push(values);
          } else if (/SELECT m.course_id/.test(sql)) {
            const lesson = state.lessons.find(row => row.id === values[0]);
            const module = state.modules.find(row => row.id === lesson?.module_id);
            rows = module ? [{ course_id: module.course_id, module_id: module.id }] : [];
          } else if (/SELECT course_id, id AS module_id/.test(sql)) {
            rows = state.modules.filter(row => row.id === values[0]).map(row => ({ course_id: row.course_id, module_id: row.id }));
          } else if (/SELECT \* FROM academy WHERE/.test(sql)) rows = state.courses.filter(row => row.id === values[0]);
          else if (/SELECT job_title_id FROM/.test(sql)) rows = state.audience.filter(row => row.course_id === values[0]);
          else if (/SELECT id FROM job_titles/.test(sql)) {
            assert.match(sql, /active=TRUE.*FOR SHARE/);
            rows = state.jobs.filter(row => row.active && values[0].includes(row.id));
          } else if (/SELECT COUNT/.test(sql)) {
            rows = [{ count: /FROM academy_modules/.test(sql)
              ? state.modules.filter(row => row.course_id === values[0]).length
              : state.lessons.filter(row => state.modules.some(m => m.id === row.module_id && m.course_id === values[0])).length }];
          } else if (/^SELECT (\*|id) FROM academy_modules/.test(sql)) {
            rows = state.modules.filter(row => /WHERE course_id/.test(sql) ? row.course_id === values[0]
              : row.id === values[0] && row.course_id === values[1]);
          } else if (/^SELECT (\*|id) FROM academy_lessons/.test(sql)) {
            rows = state.lessons.filter(row => /module_id=ANY/.test(sql) ? values[0].includes(row.module_id)
              : /WHERE module_id/.test(sql) ? row.module_id === values[0]
              : row.id === values[0] && row.module_id === values[1]);
          } else if (/FROM cms_documents d/.test(sql)) {
            rows = state.documents.filter(row => row.type === values[0] && row.source_id === values[1]);
          } else if (/FROM cms_assets/.test(sql)) rows = state.assets.filter(row => values[0].includes(row.id));
          else if (/^INSERT INTO academy \(/.test(sql)) {
            const keys = [...sql.split('VALUES')[0].matchAll(/"(\w+)"/g)].map(match => match[1]);
            const row = { id: randomUUID(), ...Object.fromEntries(keys.map((key, i) => [key, values[i]])) };
            state.courses.push(row); rows = [row];
          } else if (/^UPDATE academy SET/.test(sql)) {
            const row = state.courses.find(row => row.id === values[0]);
            for (const match of sql.matchAll(/"(\w+)"=\$(\d+)/g)) row[match[1]] = values[Number(match[2]) - 1];
            rows = [row];
          } else if (/DELETE FROM academy_course_job_titles/.test(sql)) {
            state.audience = state.audience.filter(row => row.course_id !== values[0]);
          } else if (/INSERT INTO academy_course_job_titles/.test(sql)) {
            state.audience.push(...values[1].map(job_title_id => ({ course_id: values[0], job_title_id })));
          } else if (/INSERT INTO academy_modules/.test(sql)) {
            const [course_id, title, order, active] = values;
            rows = [{ id: randomUUID(), course_id, title, order, active }]; state.modules.push(...rows);
          } else if (/INSERT INTO academy_lessons/.test(sql)) {
            const [module_id, title, description, order, active, media_type, youtube_video_id, media_url] = values;
            rows = [{ id: randomUUID(), module_id, title, description, order, active, media_type, youtube_video_id, media_url, media_version: 1 }];
            state.lessons.push(...rows);
          } else if (/WITH ORDINALITY/.test(sql)) {
            const isModule = /UPDATE academy_modules/.test(sql);
            const items = isModule ? state.modules : state.lessons;
            const parent = isModule ? 'course_id' : 'module_id';
            assert.match(sql, new RegExp(`child\\.${parent}=\\$2`));
            rows = items.filter(row => row[parent] === values[1] && values[0].includes(row.id));
            for (const row of rows) row.order = values[0].indexOf(row.id) + 1;
          } else if (/UPDATE academy_modules SET/.test(sql)) {
            const [id, title, order, active] = values;
            const row = state.modules.find(row => row.id === id);
            Object.assign(row, { title, order, active }); rows = [row];
          } else if (/UPDATE academy_lessons SET/.test(sql)) {
            const [id, title, description, order, active, media_type, youtube_video_id, media_url, increment] = values;
            const row = state.lessons.find(row => row.id === id);
            Object.assign(row, { title, description, order, active, media_type, youtube_video_id, media_url, media_version: row.media_version + increment });
            rows = [row];
          } else if (/DELETE FROM cms_documents/.test(sql)) {
            const type = /content_type='academy_lesson'/.test(sql) ? 'academy_lesson' : 'academy';
            const ids = Array.isArray(values[0]) ? values[0] : [values[0]];
            const deleted = state.documents.filter(row => row.type === type && ids.includes(row.source_id)).map(row => row.id);
            state.documents = state.documents.filter(row => !deleted.includes(row.id));
            state.revisions = state.revisions.filter(row => !deleted.includes(row.document_id));
          } else if (/^DELETE FROM academy( |_modules |_lessons )/.test(sql)) {
            const key = /academy_modules/.test(sql) ? 'modules' : /academy_lessons/.test(sql) ? 'lessons' : 'courses';
            rows = state[key].filter(row => row.id === values[0]).map(row => ({ id: row.id }));
            state[key] = state[key].filter(row => row.id !== values[0]);
            if (key === 'courses') {
              state.modules = state.modules.filter(row => row.course_id !== values[0]);
              state.audience = state.audience.filter(row => row.course_id !== values[0]);
            }
            if (key !== 'lessons') state.lessons = state.lessons.filter(row => state.modules.some(m => m.id === row.module_id));
          } else throw new Error(`Unhandled mutation SQL: ${sql}`);
          return { rows: structuredClone(rows), rowCount: rows.length };
        },
      };
    },
  };
  const course = (extra = {}) => {
    const row = { id: randomUUID(), title: 'Course', category: '', description: '', url: null, order: 0, active: false,
      delivery_mode: 'internal', audience: 'all', learning_group: 'initial', icon_key: 'icon-01', instructor_name: '', ...extra };
    state.courses.push(row); return row;
  };
  const module = (course_id, extra = {}) => {
    const row = { id: randomUUID(), course_id, title: 'Module', order: 0, active: true, ...extra };
    state.modules.push(row); return row;
  };
  const lesson = (module_id, extra = {}) => {
    const row = { id: randomUUID(), module_id, title: 'Lesson', description: '', order: 0, active: true,
      media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', media_url: null, media_version: 1, ...extra };
    state.lessons.push(row); return row;
  };
  return { state, pool, calls, users, course, module, lesson, failAudit(value = true) { failAudit = value; } };
}
