const express = require('express');
const { can } = require('../middleware/policy');
const { uuid, invalid, forbidden, parseListQuery } = require('../route-utils');
const { AcademyError } = require('../academy/errors');
const { getCourseView, getLessonView, listLessonSources } = require('../academy/catalog');

function academyFailure(error, req, res, next) {
  if (!(error instanceof AcademyError)) return next(error);
  return res.status(error.status).json({ error: 'Não foi possível acessar o conteúdo.', reason: error.reason, requestId: req.id });
}

function createAcademyLearningRouter({ pool, authenticate: authMiddleware }) {
  const router = express.Router();
  router.get('/lessons', authMiddleware, async (req, res, next) => {
    try {
      if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
      const page = parseListQuery(req.query, { all: value => value === 'true' });
      if (!page || req.query.all !== 'true') return invalid(req, res);
      const { items, total } = await listLessonSources(pool, page);
      res.set('X-Total-Count', String(total)).json(items);
    } catch (error) { academyFailure(error, req, res, next); }
  });
  for (const [path, reader] of [['/lessons/:id', getLessonView], ['/:id', getCourseView]]) {
    router.get(path, authMiddleware, async (req, res, next) => {
      try {
        if (!uuid(req.params.id) || Object.keys(req.query).some(key => key !== 'all')
          || (req.query.all !== undefined && !['true', 'false'].includes(req.query.all))) return invalid(req, res);
        const preview = req.query.all === 'true';
        if (preview && !can(req.user, 'manageAcademy')) return forbidden(req, res);
        const result = await reader(pool, req.user, req.params.id, { preview });
        if (!result) return res.status(404).json({ error: 'Conteúdo não encontrado.', reason: 'not_found', requestId: req.id });
        res.json(result);
      } catch (error) { academyFailure(error, req, res, next); }
    });
  }
  return router;
}

module.exports = { createAcademyLearningRouter, academyFailure };
