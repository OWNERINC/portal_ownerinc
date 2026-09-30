import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const supertest = require('supertest');

export async function createAcademyHttp(t, pool, users, uploadDirectory) {
  const filename = new URL('../../api/routes/academy.js', import.meta.url);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const auth = {
    can: require('./middleware/policy').can,
    authMiddleware(req, res, next) {
      req.user = users[req.get('x-fixture-user')];
      req.id = 'academy-integration';
      if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
      next();
    },
  };
  const dependencies = new Map([['../db', pool], ['../middleware/auth', auth]]);
  new Function('require', 'module', 'exports', await readFile(filename, 'utf8'))(
    name => dependencies.has(name) ? dependencies.get(name) : localRequire(name), module, module.exports);
  const app = express();
  app.use(express.json());
  app.use('/api/academy', module.exports);
  for (const [name, mount] of [['cms', '/api/cms'], ['cms-assets', '/api/cms/assets']]) {
    const routeFile = new URL(`../../api/routes/${name}.js`, import.meta.url);
    const routeRequire = createRequire(routeFile);
    const routeModule = { exports: {} };
    new Function('require', 'module', 'exports', 'process', await readFile(routeFile, 'utf8'))(
      name => dependencies.has(name) ? dependencies.get(name) : routeRequire(name), routeModule, routeModule.exports,
      { env: { ...process.env, UPLOAD_DIR: uploadDirectory } });
    app.use(mount, routeModule.exports);
  }
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'Internal error', requestId: req.id });
  });
  const server = createServer(app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { request: supertest(`http://127.0.0.1:${server.address().port}`) };
}

export function requireDisposableAcademyDatabase() {
  if (process.env.NODE_ENV === 'production') throw new Error('Academy integration cannot run in production');
  if (process.env.MIGRATION_TEST_DISPOSABLE !== 'true') throw new Error('MIGRATION_TEST_DISPOSABLE=true is required');
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
}

export async function createAcademyIntegration(t) {
  requireDisposableAcademyDatabase();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const client = await pool.connect();
  const uploadDirectory = await mkdtemp(path.join(tmpdir(), 'academy-integration-'));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));
  await mkdir(path.join(uploadDirectory, 'cms-private'));
  // A minimal, real one-page PDF with correct xref offsets.
  let pdfText = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
  ].entries()) {
    offsets.push(Buffer.byteLength(pdfText));
    pdfText += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdfText);
  pdfText += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = Buffer.from(pdfText);
  const storageKey = randomUUID();
  await writeFile(path.join(uploadDirectory, 'cms-private', storageKey), pdf);
  const ids = Object.fromEntries(['allCourse', 'closerCourse', 'captureCourse', 'closerLesson', 'captureLesson',
    'module', 'captureModule', 'pdfAsset', 'closerJob', 'captureJob'].map(key => [key, randomUUID()]));
  const users = Object.fromEntries(['closer', 'capture', 'manager', 'adminWithoutPermission', 'noJob'].map(key => [key, {
    uid: `academy-${key}-${randomUUID()}`, email: `${randomUUID()}@example.test`, name: key,
    role: ['manager', 'adminWithoutPermission'].includes(key) ? 'admin' : 'viewer',
    contract_type: 'clt', is_pj: false, permissions: key === 'manager' ? { manageAcademy: true } : {},
    job_title_id: key === 'closer' ? ids.closerJob : key === 'capture' ? ids.captureJob : null,
    job_title_active: ['closer', 'capture'].includes(key),
  }]));
  // Serialize harness fixtures on a disposable DB, without locking application tables.
  // This also makes whole-catalog assertions deterministic across concurrent test files.
  await client.query('SELECT pg_advisory_lock(7193030)');
  t.after(async () => {
    try {
      await client.query('DELETE FROM cms_documents WHERE source_id=ANY($1::uuid[])', [[ids.allCourse, ids.closerCourse, ids.captureCourse, ids.closerLesson, ids.captureLesson]]);
      await client.query('DELETE FROM academy WHERE id=ANY($1::uuid[])', [[ids.allCourse, ids.closerCourse, ids.captureCourse]]);
      await client.query('DELETE FROM cms_assets WHERE id=$1', [ids.pdfAsset]);
      await client.query('DELETE FROM users WHERE uid=ANY($1::text[])', [Object.values(users).map(user => user.uid)]);
      await client.query('DELETE FROM job_titles WHERE id=ANY($1::uuid[])', [[ids.closerJob, ids.captureJob]]);
    } finally {
      await client.query('SELECT pg_advisory_unlock(7193030)');
      client.release();
      await pool.end();
    }
  });
  assert.equal(Number((await client.query('SELECT COUNT(*) AS count FROM academy')).rows[0].count), 0,
    'Use a migrated disposable database with an empty Academy catalog');
  await client.query('INSERT INTO job_titles(id,name) VALUES ($1,$2),($3,$4)',
    [ids.closerJob, `Closer ${ids.closerJob}`, ids.captureJob, `Capture ${ids.captureJob}`]);
  for (const user of Object.values(users)) await client.query(`INSERT INTO users(uid,email,name,role,permissions,job_title_id)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [user.uid, user.email, user.name, user.role, JSON.stringify(user.permissions), user.job_title_id]);
  for (const [key, audience, group, category, order] of [
    ['allCourse', 'all', 'initial', 'Cultura', 0], ['closerCourse', 'job_titles', 'role', 'Vendas', 1],
    ['captureCourse', 'job_titles', 'role', 'Captação exclusiva', -1],
  ]) await client.query(`INSERT INTO academy(id,title,delivery_mode,audience,learning_group,category,active,"order")
    VALUES ($1,$2,'internal',$3,$4,$5,TRUE,$6)`, [ids[key], key, audience, group, category, order]);
  await client.query('INSERT INTO academy_course_job_titles(course_id,job_title_id) VALUES ($1,$2),($3,$4)',
    [ids.closerCourse, ids.closerJob, ids.captureCourse, ids.captureJob]);
  await client.query('INSERT INTO academy_modules(id,course_id,title,active) VALUES ($1,$2,$3,TRUE),($4,$5,$6,TRUE)',
    [ids.module, ids.closerCourse, 'Closer', ids.captureModule, ids.captureCourse, 'Capture']);
  await client.query(`INSERT INTO academy_lessons(id,module_id,title,active,media_type,youtube_video_id)
    VALUES ($1,$2,'Closer lesson',TRUE,'youtube','dQw4w9WgXcQ'),($3,$4,'Capture lesson',TRUE,'youtube','dQw4w9WgXcQ')`,
  [ids.closerLesson, ids.module, ids.captureLesson, ids.captureModule]);
  await client.query(`INSERT INTO cms_assets(id,storage_key,original_name,mime_type,byte_size) VALUES ($1,$2,'academy.pdf','application/pdf',$3)`, [ids.pdfAsset, storageKey, pdf.length]);
  return { pool, client, users, ids, pdf, uploadDirectory, ...await createAcademyHttp(t, pool, users, uploadDirectory) };
}
