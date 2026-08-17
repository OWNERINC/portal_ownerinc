const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { invalid, parseListQuery } = require('../route-utils');
const { listPublishedAnnouncements } = require('../cms/reader');

const router = express.Router();

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query);
  if (!page) return invalid(req, res);
  try {
    const result = await listPublishedAnnouncements(pool, page.limit, page.offset);
    res.set('X-Total-Count', String(result.count)).json(result.rows);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
