const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { invalid, parseListQuery, uuid } = require('../route-utils');
const { getPublishedAnnouncement, listPublishedAnnouncements } = require('../cms/reader');

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

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const announcement = await getPublishedAnnouncement(pool, req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.', requestId: req.id });
    res.json(announcement);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
