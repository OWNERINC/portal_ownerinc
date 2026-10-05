const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { can } = require('../middleware/policy');
const { oneOf, parseListQuery, text, uuid } = require('../route-utils');
const { createNewsBackend } = require('../owner-news/backend');

const kind = oneOf('article', 'edition');
const invalid = (req, res) => res.status(400).json({ error: 'Requisição inválida.', reason: 'invalid_request', requestId: req.id });
function validQuery(query, schema = {}) {
  return Object.entries(query).every(([key, value]) => Object.hasOwn(schema, key) && typeof value === 'string' && schema[key](value));
}
function createAnnouncementsRouter({ backend = createNewsBackend({ pool }), authenticate = authMiddleware, pollsRouter = require('./owner-news-polls') } = {}) {
  const router = express.Router();
  router.use('/polls', pollsRouter);
  router.use(authenticate);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private,no-store');
    // Reads accept no browser body (including GET JSON); identity is never input.
    if ((req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) return invalid(req, res);
    next();
  });
  function route(action, parse) {
    return async (req, res, next) => {
      const input = parse(req); if (!input) return invalid(req, res);
      const actor = { uid: req.user.uid, email: req.user.email, name: req.user.name ?? null, canManageNews: can(req.user, 'manageKnowledge') };
      if ((action === 'preview' || (action === 'asset' && input.preview)) && !actor.canManageNews) return res.status(403).json({ error: 'Acesso negado.', reason: 'forbidden', requestId: req.id });
      const controller = new AbortController();
      const abort = () => { if (!res.writableFinished) controller.abort(); };
      req.on('aborted', abort); res.on('close', abort);
      try {
        const result = await backend[action](input, actor, { signal: controller.signal, requestId: req.id });
        if (controller.signal.aborted) { await result?.body?.cancel(); return; }
        if (result === null) throw Object.assign(new Error('not_found'), { status: 404 });
        if (action === 'asset') {
          res.status(result.status).set(result.headers);
          if (!result.body) return res.end();
          await pipeline(Readable.fromWeb(result.body), res, { signal: controller.signal });
        } else if (action === 'list') res.set('X-Total-Count', String(result.count)).json(result.rows);
        else res.json(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (res.headersSent) return res.destroy();
        if ([400, 403, 404, 503].includes(error.status)) {
          const reason = ({ 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 503: 'news_unavailable' })[error.status];
          return res.status(error.status).json({ error: error.status === 404 ? 'Publicação não encontrada.' : error.status === 503 ? 'Owner News indisponível.' : 'Requisição inválida.', reason, requestId: req.id });
        }
        next(error);
      } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
    };
  }
  router.get('/', route('list', req => {
    const page = parseListQuery(req.query, { category: text(100), kind });
    return page && { ...page, ...(req.query.category === undefined ? {} : { category: req.query.category }), ...(req.query.kind === undefined ? {} : { kind: req.query.kind }) };
  }));
  router.get('/categories', route('categories', req => validQuery(req.query, { kind, with_counts: oneOf('true', 'false') }) && { withCounts: req.query.with_counts === 'true', ...(req.query.kind === undefined ? {} : { kind: req.query.kind }) }));
  router.get('/home', route('home', req => validQuery(req.query) && {}));
  for (const [path, preview] of [['/assets/:id', false], ['/preview/assets/:id', true]]) router.get(path, route('asset', req => uuid(req.params.id) && validQuery(req.query) && { id: req.params.id.toLowerCase(), preview, range: req.get('Range') || null }));
  router.get('/preview/:id', route('preview', req => uuid(req.params.id) && uuid(req.query.version) && validQuery(req.query, { version: uuid, source: oneOf('payload', 'legacy') }) && { id: req.params.id.toLowerCase(), versionId: req.query.version.toLowerCase(), source: req.query.source || 'payload' }));
  router.get('/:id/navigation', route('navigation', req => uuid(req.params.id) && validQuery(req.query, { category: text(100) }) && { id: req.params.id.toLowerCase(), ...(req.query.category === undefined ? {} : { category: req.query.category }) }));
  router.get('/:id', route('detail', req => uuid(req.params.id) && validQuery(req.query) && { id: req.params.id.toLowerCase() }));
  return router;
}
module.exports = createAnnouncementsRouter();
module.exports.createAnnouncementsRouter = createAnnouncementsRouter;
