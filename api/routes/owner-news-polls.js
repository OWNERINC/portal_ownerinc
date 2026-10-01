const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canManageCms } = require('../cms/permissions');
const { uuid, oneOf, parseListQuery, withAudit } = require('../route-utils');
const { validVersion } = require('../owner-news/home');
const { PollError, normalizePollDraft, createPollDraft, updatePollDraft, publishPoll, closePoll,
  readPoll, readCurrentPoll, listPolls, voteOnPoll } = require('../owner-news/polls');

const router = express.Router();
const admin = express.Router();
const messages = {
  invalid_request: 'Requisição inválida.', invalid_poll: 'A enquete é inválida.',
  poll_not_found: 'Enquete não encontrada.', invalid_option: 'Opção inválida.',
  already_voted: 'Você já votou em outra opção. Recarregue para consultar sua escolha.',
  poll_closed: 'Esta enquete está encerrada.', active_poll_exists: 'Já existe uma enquete aberta.',
  version_conflict: 'A enquete foi alterada. Recarregue antes de continuar.',
  poll_frozen: 'Uma enquete publicada não pode ser alterada ou reaberta.',
  poll_not_open: 'Somente uma enquete aberta pode ser encerrada.',
};
function sendError(error, req, res, next) {
  // withAudit has rolled back before a constraint failure reaches this boundary.
  if (error.code === '23505' && error.constraint === 'owner_news_one_open_poll') error = new PollError(409, 'active_poll_exists');
  if (!(error instanceof PollError)) return next(error);
  return res.status(error.status).json({ error: messages[error.code], reason: error.code, requestId: req.id });
}
function invalid() { throw new PollError(400, 'invalid_request'); }
function noQuery(req) { if (Object.keys(req.query).length) invalid(); }
function pollId(req) {
  if (!uuid(req.params.id)) invalid();
  return req.params.id.toLowerCase();
}
function exactBody(body, keys) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
}
function authorize(req, res, next) {
  if (!canManageCms(req.user, 'announcement')) return res.status(403).json({ error: 'Permissão negada.', reason: 'forbidden', requestId: req.id });
  next();
}

router.get('/current', authMiddleware, async (req, res, next) => {
  try { noQuery(req); res.json({ poll: await readCurrentPoll(pool, req.user.uid) }); }
  catch (error) { sendError(error, req, res, next); }
});
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    noQuery(req);
    const poll = await readPoll(pool, pollId(req), req.user.uid);
    if (!poll) throw new PollError(404, 'poll_not_found');
    res.json(poll);
  } catch (error) { sendError(error, req, res, next); }
});
router.post('/:id/votes', authMiddleware, async (req, res, next) => {
  try {
    noQuery(req);
    const id = pollId(req);
    if (!exactBody(req.body, ['option_id']) || !uuid(req.body.option_id)) invalid();
    const result = await withAudit(pool, req, 'owner_news.poll.vote', 'owner_news_poll',
      db => voteOnPoll(db, id, req.body.option_id.toLowerCase(), req.user.uid),
      { targetId: id, details: result => ({ recorded: result.recorded }) });
    res.json(result.poll);
  } catch (error) { sendError(error, req, res, next); }
});

admin.get('/', authMiddleware, authorize, async (req, res, next) => {
  try {
    const page = parseListQuery(req.query, { status: oneOf('draft', 'open', 'closed') });
    if (!page) invalid();
    const result = await listPolls(pool, req.user.uid, { ...page, status: req.query.status });
    res.set('X-Total-Count', String(result.count)).json(result.rows);
  } catch (error) { sendError(error, req, res, next); }
});
admin.post('/', authMiddleware, authorize, async (req, res, next) => {
  try {
    noQuery(req);
    const content = normalizePollDraft(req.body);
    if (!content) invalid();
    const result = await withAudit(pool, req, 'owner_news.poll.create', 'owner_news_poll',
      db => createPollDraft(db, content, req.user.uid), { targetId: row => row.id, details: row => ({ version: row.version }) });
    res.status(201).json(result);
  } catch (error) { sendError(error, req, res, next); }
});
admin.put('/:id/draft', authMiddleware, authorize, async (req, res, next) => {
  try {
    noQuery(req);
    const id = pollId(req);
    if (!exactBody(req.body, ['title', 'question', 'description', 'closing', 'options', 'expected_version'])
      || !validVersion(req.body.expected_version)) invalid();
    const { expected_version: version, ...draft } = req.body;
    const content = normalizePollDraft(draft);
    if (!content) invalid();
    const result = await withAudit(pool, req, 'owner_news.poll.update', 'owner_news_poll',
      db => updatePollDraft(db, id, content, version, req.user.uid), { targetId: id, details: row => ({ version: row.version }) });
    res.json(result);
  } catch (error) { sendError(error, req, res, next); }
});
for (const [action, operation] of [['publish', publishPoll], ['close', closePoll]]) {
  admin.post(`/:id/${action}`, authMiddleware, authorize, async (req, res, next) => {
    try {
      noQuery(req);
      const id = pollId(req);
      if (!exactBody(req.body, ['expected_version']) || !validVersion(req.body.expected_version)) invalid();
      const result = await withAudit(pool, req, `owner_news.poll.${action}`, 'owner_news_poll',
        db => operation(db, id, req.body.expected_version, req.user.uid), { targetId: id, details: row => ({ version: row.version }) });
      res.json(result);
    } catch (error) { sendError(error, req, res, next); }
  });
}

module.exports = router;
module.exports.admin = admin;
