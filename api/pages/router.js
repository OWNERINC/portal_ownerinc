const express = require('express');
const multer = require('multer');
const { createHash } = require('node:crypto');
const { uuid, parseListQuery } = require('../route-utils');
const { PagesError, validateMutation } = require('./validation');
const { editor, publisher, mayEdit } = require('./access');
const { templates } = require('./templates');
const store = require('./store');
const media = require('./media');
const { admit } = require('./media-runner');

function createPagesRouter({ pool, authenticate, uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads' }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const json = res.json.bind(res);
    res.json = body => json(body?.error ? { ...body, reason: body.reason || ({ 400: 'invalid_request', 401: 'authentication_required', 403: 'permission_denied', 404: 'not_visible', 413: 'payload_too_large', 429: 'rate_limited' }[res.statusCode] || 'internal_error'), requestId: body.requestId || req.id || null } : body);
    next();
  });
  // Explicit per-route authentication preserves the global Ethics gate and makes
  // it impossible for a future literal route to accidentally skip authentication.
  const authMiddleware = authenticate;
  const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };
  const deny = () => { throw new PagesError(403, 'permission_denied'); };
  const id = value => { if (!uuid(value)) throw new PagesError(400, 'invalid_id'); return value.toLowerCase(); };
  const manager = user => { if (!editor(user) && !publisher(user)) deny(); };
  const listQuery = req => {
    const parsed = parseListQuery(req.query, { q: value => value.length <= 200, tag: value => value.length <= 40 });
    if (!parsed) throw new PagesError(400, 'invalid_query'); return { ...req.query, ...parsed };
  };
  router.get('/templates', authMiddleware, wrap(async (req, res) => { manager(req.user); res.json(templates); }));
  router.get('/job-titles', authMiddleware, wrap(async (req, res) => {
    manager(req.user);
    const parsed = parseListQuery(req.query); if (!parsed) throw new PagesError(400, 'invalid_query');
    const result = await pool.query(`WITH selected AS (SELECT id,name,active FROM job_titles ORDER BY lower(name),id LIMIT $1 OFFSET $2)
      SELECT (SELECT count(*)::integer FROM job_titles) AS total, COALESCE((SELECT json_agg(selected) FROM selected),'[]'::json) AS items`, [parsed.limit, parsed.offset]);
    res.set('X-Total-Count', String(result.rows[0].total)).json(result.rows[0].items);
  }));
  router.get('/manage', authMiddleware, wrap(async (req, res) => {
    manager(req.user); const result = await store.list(pool, req.user, listQuery(req), true);
    res.set('X-Total-Count', String(result.total)).json(result.items);
  }));
  router.get('/:id/workspace', authMiddleware, wrap(async (req, res) => {
    manager(req.user); res.json(await store.workspace(pool, req.user, id(req.params.id)));
  }));
  router.get('/:id/preview', authMiddleware, wrap(async (req, res) => {
    manager(req.user);
    if (Object.keys(req.query).some(key => key !== 'revision_id')) throw new PagesError(400, 'invalid_query');
    res.json(await store.preview(pool, req.user, id(req.params.id), req.query.revision_id === undefined ? null : id(req.query.revision_id)));
  }));
  router.get('/', authMiddleware, wrap(async (req, res) => {
    const result = await store.list(pool, req.user, listQuery(req));
    res.set('X-Total-Count', String(result.total)).json(result.items);
  }));
  router.get('/:id/media/:mediaId', authMiddleware, wrap(async (req, res) => {
    if (Object.keys(req.query).some(key => !['revision_id','preview'].includes(key)) || (req.query.preview !== undefined && req.query.preview !== '1')
      || (req.query.preview && req.query.revision_id)) throw new PagesError(400, 'invalid_query');
    if (req.query.preview || req.query.revision_id) manager(req.user);
    const record = await store.mediaRecord(pool, req.user, id(req.params.id), id(req.params.mediaId), {
      revisionId: req.query.revision_id === undefined ? null : id(req.query.revision_id), staged: req.query.preview === '1',
    });
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': record.mime_type });
    await new Promise((resolve, reject) => res.sendFile(media.mediaPath(uploadDirectory, record.storage_key), { acceptRanges: false }, err => err ? reject(err.code === 'ENOENT' ? new PagesError(404, 'media_unavailable') : err) : resolve()));
  }));
  router.get('/:id', authMiddleware, wrap(async (req, res) => { res.json(await store.reader(pool, req.user, id(req.params.id))); }));
  router.post('/', authMiddleware, wrap(async (req, res) => {
    if (!editor(req.user)) deny(); validateMutation(req.body, 'create');
    const result = await store.mutate(pool, req, 'create', null, req.body); res.status(result.status).json(result.ack);
  }));
  router.put('/:id/draft', authMiddleware, wrap(async (req, res) => {
    if (!editor(req.user)) deny(); const pageId = id(req.params.id); validateMutation(req.body, 'draft');
    const result = await store.mutate(pool, req, 'draft', pageId, req.body); res.status(result.status).json(result.ack);
  }));
  for (const operation of ['publish','archive','restore']) router.post(`/:id/${operation}`, authMiddleware, wrap(async (req, res) => {
    if (!publisher(req.user)) deny(); const pageId = id(req.params.id); validateMutation(req.body, operation);
    const result = await store.mutate(pool, req, operation, pageId, req.body); res.status(result.status).json(result.ack);
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: media.LIMITS.video, files: 1, fields: 2, fieldSize: 100, parts: 3 } }).fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]);
  const parseUpload = (req, res, next) => upload(req, res, err => next(err && !(err instanceof multer.MulterError) ? new PagesError(400, 'invalid_upload') : err));
  // Ownership precedes multipart buffering/decoding and is checked again under lock.
  router.post('/:id/media', authMiddleware, (req, res, next) => {
    Promise.resolve().then(async () => {
      if (!editor(req.user)) deny(); const page = await store.pageRow(pool, id(req.params.id));
      if (!mayEdit(req.user, page)) throw new PagesError(403, 'author_only');
      req.releaseMedia = admit();
      req.mediaController = new AbortController();
      const cancel = () => { req.mediaController.abort(); if (!req.mediaProcessing) req.releaseMedia(); };
      req.on('aborted', cancel);
      res.on('close', () => { if (!res.writableEnded) cancel(); });
    }).then(() => next(), next);
  }, parseUpload, wrap(async (req, res) => {
    req.mediaProcessing = true;
    const kind = req.body?.kind || 'image', file = req.files?.[kind === 'image' ? 'image' : 'file']?.[0];
    if (!file || !uuid(req.body?.client_mutation_id) || !Object.hasOwn(media.LIMITS, kind)
      || Object.keys(req.body).some(key => !['client_mutation_id','kind'].includes(key))
      || (kind !== 'image' && !req.body.kind)) throw new PagesError(400, 'invalid_upload');
    const body = { client_mutation_id: req.body.client_mutation_id,
      kind, source_sha256: createHash('sha256').update(file.buffer).digest('hex') };
    const normalized = await media.normalizePageMedia(file.buffer, kind, { signal: req.mediaController.signal });
    if (req.mediaController.signal.aborted) throw new PagesError(499, 'upload_cancelled');
    const image = await media.writeImage(uploadDirectory, normalized);
    try {
      const result = await store.mutate(pool, req, 'media', id(req.params.id), body, image);
      if (result.replay) await media.compensate(image);
      res.status(result.status).json(result.ack);
    } catch (err) {
      // A lost COMMIT acknowledgement may already have registered the file.
      if (!err.commitAmbiguous) await media.compensate(image); throw err;
    } finally { req.releaseMedia?.(); }
  }));
  router.use((err, req, res, next) => {
    req.releaseMedia?.();
    if (res.headersSent) return next(err);
    let status = err.status || 500, reason = err.reason || 'internal_error';
    if (err instanceof multer.MulterError) { status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400; reason = err.code === 'LIMIT_FILE_SIZE' ? 'image_too_large' : 'invalid_upload'; }
    res.status(status).json({ error: status === 500 ? 'Não foi possível concluir a operação.' : err.message, reason, requestId: req.id || null });
  });
  return router;
}
module.exports = { createPagesRouter };
