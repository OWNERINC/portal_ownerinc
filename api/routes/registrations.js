const express = require('express');
const pool = require('../db');
const { authMiddleware, can, firebaseAuth } = require('../middleware/auth');
const { forbidden, integer, invalid, oneOf, parseListQuery, text, uuid, validBody } = require('../route-utils');
const { approvePendingRegistration, rejectPendingRegistration, withRegistrationOperation } = require('../services/pending-registration');

const router = express.Router();
const listQuery = { status: (value) => ['pending', 'approved', 'rejected'].includes(value) };
const approvalDueDay = (value) => value === undefined || value === null || integer(1, 31)(value);
const approveSchema = { job_title_id: uuid, contract_type: oneOf('clt', 'pj'), pj_due_day: approvalDueDay };
const rejectSchema = { reason: (value) => value === null || text(500)(value) };

function canManage(req, res) {
  if (!can(req.user, 'manageUsers')) {
    forbidden(req, res);
    return false;
  }
  return true;
}

async function registrationState(registration) {
  if (registration.status !== 'pending') return {
    state: registration.status,
    state_label: registration.status === 'approved' ? 'Aprovado' : 'Rejeitado',
  };
  const firebaseUser = await firebaseAuth.getUser(registration.firebase_uid).catch(() => null);
  return firebaseUser?.emailVerified === true
    ? { state: 'confirmed', state_label: 'E-mail confirmado; pendente de aprovação', email_verified: true }
    : { state: 'received', state_label: 'Cadastro recebido; confirmação de e-mail pendente', email_verified: false };
}

router.get('/', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  const status = req.query.status || 'pending';
  try {
    const [result, count] = await Promise.all([
      pool.query(
         `SELECT id, firebase_uid, name, email, status, created_at, reviewed_at, reviewed_by, rejection_reason
          FROM pending_registrations WHERE status = $3
         ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
        [page.limit, page.offset, status],
      ),
      pool.query('SELECT COUNT(*)::integer AS total FROM pending_registrations WHERE status = $1', [status]),
     ]);
     res.setHeader('X-Total-Count', count.rows[0].total);
     const states = await Promise.all(result.rows.map(registrationState));
     res.json(result.rows.map((row, index) => {
       const { firebase_uid: _firebaseUid, ...publicRow } = row;
       return { ...publicRow, ...states[index] };
     }));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  if (!uuid(req.params.id) || !validBody(req.body, approveSchema, ['job_title_id', 'contract_type'])) return invalid(req, res);
  if (req.body.contract_type === 'pj' && !integer(1, 31)(req.body.pj_due_day)) return invalid(req, res);
  if (req.body.contract_type === 'clt' && req.body.pj_due_day !== undefined && req.body.pj_due_day !== null) return invalid(req, res);
  let client;
  let discardClient = false;
  try {
    const result = await withRegistrationOperation(async () => {
      client = await pool.connect();
       const approval = await approvePendingRegistration({
          client, pool,
         id: req.params.id,
         jobTitleId: req.body.job_title_id,
         contractType: req.body.contract_type,
         pjDueDay: req.body.pj_due_day,
         reviewerUid: req.user.uid,
         requestId: req.id,
       });
      discardClient = approval?.discardClient === true;
      return approval;
    });
    res.json(result);
  } catch (error) {
    discardClient ||= error.discardClient === true;
    if (error.code === 'REGISTRATION_NOT_FOUND') return res.status(404).json({ error: 'Solicitação não encontrada.', requestId: req.id });
    if (error.code === 'REGISTRATION_ALREADY_REVIEWED') return res.status(409).json({ error: 'Solicitação já analisada.', requestId: req.id });
    if (error.code === 'REGISTRATION_IDENTITY_CHANGED') return res.status(409).json({ error: 'A identidade da solicitação mudou; tente novamente.', requestId: req.id });
    if (error.code === 'REGISTRATION_RETENTION_PENDING') return res.status(409).json({ error: 'Solicitação em retenção.', requestId: req.id });
    if (error.code === 'INVALID_JOB_TITLE') return invalid(req, res);
    if (error.code === 'INVALID_CONTRACT') return invalid(req, res);
    if (error.code === 'EMAIL_NOT_VERIFIED') return res.status(422).json({ error: 'O e-mail ainda não foi confirmado.', requestId: req.id });
    if (error.code === 'REGISTRATION_IDENTITY_MISSING') return res.status(409).json({ error: 'A identidade do cadastro não está disponível.', requestId: req.id });
    if (error.code === 'REGISTRATION_BUSY') return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
    if (error.code === 'USER_ALREADY_EXISTS' || error.code === '23505') return res.status(409).json({ error: 'A conta já existe.', requestId: req.id });
    next(error);
  } finally {
    client?.release(discardClient);
  }
});

router.post('/:id/reject', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  if (!uuid(req.params.id) || !validBody(req.body || {}, rejectSchema)) return invalid(req, res);
  let client;
  let discardClient = false;
  try {
    const result = await withRegistrationOperation(async () => {
      client = await pool.connect();
       const rejection = await rejectPendingRegistration({
         client, pool, id: req.params.id, reviewerUid: req.user.uid, reason: req.body?.reason?.trim() || null, requestId: req.id,
       });
      discardClient = rejection?.discardClient === true;
      return rejection;
    });
    res.json(result);
  } catch (error) {
    discardClient ||= error.discardClient === true;
    if (error.code === 'REGISTRATION_NOT_FOUND') return res.status(404).json({ error: 'Solicitação não encontrada.', requestId: req.id });
    if (error.code === 'REGISTRATION_ALREADY_REVIEWED') return res.status(409).json({ error: 'Solicitação já analisada.', requestId: req.id });
    if (error.code === 'REGISTRATION_IDENTITY_CHANGED') return res.status(409).json({ error: 'A identidade da solicitação mudou; tente novamente.', requestId: req.id });
    if (error.code === 'REGISTRATION_RETENTION_PENDING') return res.status(409).json({ error: 'Solicitação em retenção.', requestId: req.id });
    if (error.code === 'REGISTRATION_BUSY') return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
    next(error);
  } finally {
    client?.release(discardClient);
  }
});

module.exports = router;
