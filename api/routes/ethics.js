const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { acceptTerm, term } = require('../ethics');
const router = express.Router();

router.get('/', authMiddleware, (req, res) => res.json({ term, accepted: req.user.ethics_accepted === true }));

router.post('/accept', authMiddleware, async (req, res, next) => {
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== 'object'
    || Object.keys(body).length !== 3
    || !Object.keys(body).every(key => ['version', 'contentHash', 'accepted'].includes(key))
    || body.accepted !== true || typeof body.version !== 'string' || typeof body.contentHash !== 'string') {
    return res.status(400).json({ error: 'Confirme a leitura e o aceite do termo apresentado.', requestId: req.id });
  }
  if (body.version !== term.version || body.contentHash !== term.contentHash) {
    return res.status(409).json({ error: 'O termo foi atualizado. Recarregue para ler a versão atual.', reason: 'ethics-version-changed', requestId: req.id });
  }
  try {
    const acceptance = await acceptTerm(pool, req.user.uid);
    return res.json({ accepted: true, version: term.version, contentHash: term.contentHash, acceptedAt: acceptance.accepted_at });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
