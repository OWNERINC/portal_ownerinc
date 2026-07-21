const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { can } = require('../middleware/policy');
const { rateLimit } = require('../middleware/security');
const { hasEmployeeAccess, readSolidesConfig, STAGES } = require('../integrations/solides-config');
const { SolidesError, solidesCheck, solidesJson } = require('../integrations/solides');
const { invalid, parseListQuery, validBody, text, oneOf, withAudit } = require('../route-utils');

const router = express.Router();
const employeeRequestLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, key: (req) => req.user.uid });
const adminProbeLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, key: (req) => req.user.uid });

const hidden = (req, res) => res.status(404).json({ error: 'Not found.', requestId: req.id });

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.content) ? payload.content : [];
}

function isoTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'number' || /^\d+$/.test(String(value))
    ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const instant = new Date(`${value}T00:00:00-03:00`);
  return Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value ? null : instant;
}

function dateRange(query, maxSpan = 30) {
  const today = new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  const from = parseDate(query.from || query.date || today);
  const to = parseDate(query.to || query.date || query.from || today);
  if (!from || !to) return null;
  const span = Math.round((to - from) / 86400000);
  if (span < 0 || span > maxSpan) return null;
  return { from: from.getTime(), to: to.getTime() + 86400000 - 1 };
}

function positiveBigInt(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return false;
  try { return BigInt(value) <= 9223372036854775807n; } catch { return false; }
}

function verificationTransitionAllowed(existing, employeeId, status) {
  return status !== 'verified' || Boolean(existing && existing.employee_id === employeeId);
}

function employeeMatchesLink(employee, employeeId, externalId) {
  if (!employee || employee.fired === true || String(employee.id) !== employeeId) return false;
  return !externalId || String(employee.externalId ?? '') === externalId;
}

function finiteNumber(value) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeSummary(row) {
  return {
    employeeId: String(row.employeeId),
    startAt: isoTimestamp(row.startDateTimestamp),
    endAt: isoTimestamp(row.endDateTimestamp),
    status: ['APPROVED', 'PENDING', 'REPROVED'].includes(row.status) ? row.status : null,
  };
}

function normalizePunch(row) {
  return {
    id: row.id === undefined || row.id === null ? null : String(row.id),
    date: isoTimestamp(row.date),
    dateIn: isoTimestamp(row.dateInFull || row.dateIn),
    dateOut: isoTimestamp(row.dateOutFull || row.dateOut),
    status: ['APPROVED', 'PENDING', 'REPROVED'].includes(row.status) ? row.status : null,
    pendingType: ['ENTRADA', 'SAIDA', 'AMBOS'].includes(row.pendingType) ? row.pendingType : null,
    adjusted: row.adjust === true,
    edited: row.edited === true || row.editedIn === true || row.editedOut === true,
    excluded: row.excluded === true,
    lastModifiedAt: isoTimestamp(row.lastModifiedDate),
  };
}

function normalizeAdjustment(row) {
  return {
    id: row.id === undefined || row.id === null ? null : String(row.id),
    allDay: row.allDay === true,
    startAt: isoTimestamp(row.startDate),
    endAt: isoTimestamp(row.endDate),
    recordedAt: isoTimestamp(row.recordDate),
    status: ['APROVADO', 'PENDENTE', 'REPROVADO'].includes(row.status) ? row.status : null,
  };
}

function adjustmentEmployeeId(row) {
  const value = row?.employeeId ?? row?.employee?.id;
  return value === undefined || value === null ? null : String(value);
}

function shiftTime(milliseconds) {
  if (!Number.isFinite(Number(milliseconds)) || Number(milliseconds) < 0 || Number(milliseconds) >= 86400000) return null;
  const totalMinutes = Math.floor(Number(milliseconds) / 60000);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function normalizeEmployee(employee) {
  const schedule = employee.currentWorkSchedule || null;
  return {
    employeeId: String(employee.id),
    externalId: employee.externalId || null,
    name: employee.name || '',
    fired: employee.fired === true,
    recordsPunch: employee.recordsPunch === true,
    admissionDate: isoTimestamp(employee.admissionDate),
    jobRole: employee.jobRoleDTO?.description || employee.jobRoleDTO?.name || null,
    workplace: employee.currentWorkplaceDTO?.name || null,
    schedule: schedule ? {
      id: String(schedule.id),
      name: schedule.name || '',
      days: (schedule.workScheduleTimetableList || []).map((day) => ({
        day: day.day,
        shifts: [1, 2, 3, 4, 5, 6].map((index) => ({
          start: shiftTime(day[`startShift${index}`]), end: shiftTime(day[`endShift${index}`]),
        })).filter((shift) => shift.start && shift.end),
      })),
    } : null,
  };
}

async function employeeLink(uid) {
  const { rows: [link] } = await pool.query(
    `SELECT user_uid, employee_id::text, external_id, employer_scope, status, verified_at, last_seen_at
     FROM solides_employee_links WHERE user_uid = $1`,
    [uid]
  );
  return link || null;
}

async function requireEmployeeLink(req, res) {
  const config = readSolidesConfig();
  if (!hasEmployeeAccess(req.user, config)) {
    hidden(req, res);
    return null;
  }
  const link = await employeeLink(req.user.uid);
  if (!link || link.status !== 'verified') {
    hidden(req, res);
    return null;
  }
  return { config, link };
}

function upstreamFailure(error, req, res, next) {
  if (!(error instanceof SolidesError)) return next(error);
  console.error(JSON.stringify({ service: 'api', event: 'solides_request_failed', requestId: req.id, status: error.upstreamStatus || null }));
  return res.status(503).json({ error: 'Integration temporarily unavailable.', requestId: req.id });
}

router.get('/me/status', authMiddleware, async (req, res, next) => {
  try {
    if (Object.keys(req.query).length) return invalid(req, res);
    const config = readSolidesConfig();
    if (!hasEmployeeAccess(req.user, config)) return hidden(req, res);
    const link = await employeeLink(req.user.uid);
    res.json({
      available: true,
      stage: config.stage,
      linked: link?.status === 'verified',
      linkStatus: link?.status || 'missing',
    });
  } catch (error) { next(error); }
});

router.get('/me/summary', authMiddleware, employeeRequestLimit, async (req, res, next) => {
  try {
    const access = await requireEmployeeLink(req, res);
    if (!access) return;
    if (Object.keys(req.query).some((key) => key !== 'date')) return invalid(req, res);
    const range = dateRange(req.query);
    if (!range) return invalid(req, res);
    const payload = await solidesJson('punch', 'summary', {
      config: access.config,
      query: { employeeId: access.link.employee_id, startDateInMillis: range.from, endDateInMillis: range.to, page: 0, size: 20 },
    });
    const entries = asArray(payload).filter((row) => String(row.employeeId) === access.link.employee_id).map(normalizeSummary);
    res.json({ source: 'solides', dataAsOf: new Date().toISOString(), entries });
  } catch (error) { upstreamFailure(error, req, res, next); }
});

router.get('/me/punches', authMiddleware, employeeRequestLimit, async (req, res, next) => {
  try {
    const access = await requireEmployeeLink(req, res);
    if (!access) return;
    const range = dateRange(req.query);
    const page = parseListQuery(req.query, { from: () => true, to: () => true });
    if (!range || !page || page.offset % page.limit !== 0) return invalid(req, res);
    const payload = await solidesJson('punch', '', {
      config: access.config,
      query: {
        employeeId: access.link.employee_id, startDateInMillis: range.from, endDateInMillis: range.to,
        page: page.offset / page.limit, size: page.limit, showSecurityCode: false,
      },
    });
    const rows = asArray(payload);
    const entries = rows.filter((row) => String(row.employeeId) === access.link.employee_id).map(normalizePunch);
    if (entries.length === rows.length && Number.isSafeInteger(payload?.totalElements)) {
      res.setHeader('X-Total-Count', payload.totalElements);
    }
    res.json({ source: 'solides', dataAsOf: new Date().toISOString(), entries });
  } catch (error) { upstreamFailure(error, req, res, next); }
});

router.get('/me/hours-balance', authMiddleware, employeeRequestLimit, async (req, res, next) => {
  try {
    const access = await requireEmployeeLink(req, res);
    if (!access) return;
    if (Object.keys(req.query).some((key) => !['from', 'to'].includes(key))) return invalid(req, res);
    const range = dateRange(req.query);
    if (!range) return invalid(req, res);
    const payload = await solidesJson('punch', 'hoursBalance', {
      config: access.config,
      query: { employeeId: access.link.employee_id, startDate: range.from, endDate: range.to },
    });
    const row = asArray(payload).find((item) => String(item.employeeId) === access.link.employee_id);
    res.json({
      source: 'solides', dataAsOf: new Date().toISOString(),
      hoursBalanceInMinutes: finiteNumber(row?.hoursBalanceInMinutes),
    });
  } catch (error) { upstreamFailure(error, req, res, next); }
});

router.get('/me/schedule', authMiddleware, employeeRequestLimit, async (req, res, next) => {
  try {
    if (Object.keys(req.query).length) return invalid(req, res);
    const access = await requireEmployeeLink(req, res);
    if (!access) return;
    const employee = await solidesJson('employer', 'employee/find', {
      config: access.config, query: { tangerinoId: access.link.employee_id, ignoreFired: false },
    });
    if (!employeeMatchesLink(employee, access.link.employee_id, access.link.external_id)) {
      throw new SolidesError('Sólides returned an unexpected employee');
    }
    await pool.query(
      'UPDATE solides_employee_links SET last_seen_at = NOW() WHERE user_uid = $1 AND employee_id = $2',
      [req.user.uid, access.link.employee_id]
    );
    res.json({ source: 'solides', dataAsOf: new Date().toISOString(), employee: normalizeEmployee(employee) });
  } catch (error) { upstreamFailure(error, req, res, next); }
});

router.get('/me/adjustments', authMiddleware, employeeRequestLimit, async (req, res, next) => {
  try {
    const access = await requireEmployeeLink(req, res);
    if (!access) return;
    if (Object.keys(req.query).some((key) => !['from', 'to', 'pending', 'status'].includes(key))) return invalid(req, res);
    const range = dateRange(req.query, 365);
    if (!range || (req.query.pending !== undefined && !['true', 'false'].includes(req.query.pending))
      || (req.query.status !== undefined && !['APROVADO', 'PENDENTE', 'REPROVADO'].includes(req.query.status))) return invalid(req, res);
    const payload = await solidesJson('employer', `v2/adjustments/employees/${access.link.employee_id}`, {
      config: access.config,
      query: {
        startDate: range.from, endDate: range.to,
        pending: req.query.pending, status: req.query.status,
      },
    });
    const entries = asArray(payload)
      .filter((row) => adjustmentEmployeeId(row) === access.link.employee_id)
      .map(normalizeAdjustment);
    res.json({ source: 'solides', dataAsOf: new Date().toISOString(), entries });
  } catch (error) { upstreamFailure(error, req, res, next); }
});

function requireAdminFeature(req, res) {
  const config = readSolidesConfig();
  if (config.stageRank < STAGES.internal || !can(req.user, 'manageSolides')) return null;
  return config;
}

router.get('/admin/status', authMiddleware, async (req, res, next) => {
  try {
    if (Object.keys(req.query).length) return invalid(req, res);
    const config = requireAdminFeature(req, res);
    if (!config) return hidden(req, res);
    const { rows: [counts] } = await pool.query(
      `SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
        COUNT(*) FILTER (WHERE status = 'conflict')::int AS conflicts
       FROM solides_employee_links`
    );
    res.json({ stage: config.stage, reportConfigured: Boolean(config.reportBaseUrl), pilotUsers: config.pilotUids.size, links: counts });
  } catch (error) { next(error); }
});

router.get('/admin/users', authMiddleware, async (req, res, next) => {
  try {
    if (!requireAdminFeature(req, res)) return hidden(req, res);
    const page = parseListQuery(req.query);
    if (!page) return invalid(req, res);
    const result = await withAudit(pool, req, 'solides.users.read', 'solides_link', async (client) => {
      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        client.query(`SELECT uid, name, email FROM users
          WHERE contract_type = 'clt' AND is_pj = FALSE
          ORDER BY lower(name), lower(email), uid LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
        client.query("SELECT COUNT(*)::int AS total FROM users WHERE contract_type = 'clt' AND is_pj = FALSE"),
      ]);
      return { rows, total };
    }, { targetId: 'eligible-users', details: (result) => ({ count: result.rows.length }) });
    res.setHeader('X-Total-Count', result.total);
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.post('/admin/probe', authMiddleware, adminProbeLimit, async (req, res, next) => {
  try {
    const config = requireAdminFeature(req, res);
    if (!config) return hidden(req, res);
    if (!validBody(req.body, { userUid: (value) => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128) })) {
      return invalid(req, res);
    }

    let link = null;
    if (req.body.userUid) link = await employeeLink(req.body.userUid);
    const checks = [{ name: 'employer.test', service: 'employer', path: 'test' }];
    if (link) {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const start = new Date(`${date}T00:00:00-03:00`).getTime();
      const end = start + 86400000 - 1;
      checks.push(
        { name: 'employer.employee', service: 'employer', path: 'employee/find', query: { tangerinoId: link.employee_id, ignoreFired: false } },
        { name: 'punch.summary', service: 'punch', path: 'summary', query: { employeeId: link.employee_id, startDateInMillis: start, endDateInMillis: end, page: 0, size: 20 } },
        { name: 'punch.history', service: 'punch', path: '', query: { employeeId: link.employee_id, startDateInMillis: start, endDateInMillis: end, page: 0, size: 20, showSecurityCode: false } },
        { name: 'punch.hoursBalance', service: 'punch', path: 'hoursBalance', query: { employeeId: link.employee_id, startDate: start, endDate: end } },
        { name: 'employer.adjustments', service: 'employer', path: `v2/adjustments/employees/${link.employee_id}`, query: { startDate: start, endDate: end } },
      );
    }
    const results = [];
    for (const check of checks) {
      results.push({ name: check.name, ...await solidesCheck(check.service, check.path, { config, query: check.query }) });
    }
    const report = { checkedAt: new Date().toISOString(), employeeProbeEnabled: Boolean(link), checks: results };
    await withAudit(pool, req, 'solides.probe', 'solides_integration', async () => report, {
      targetId: req.body.userUid || 'connectivity',
      details: { employeeProbeEnabled: Boolean(link), successful: results.filter((result) => result.ok).length, total: results.length },
    });
    res.json(report);
  } catch (error) { next(error); }
});

router.get('/admin/links', authMiddleware, async (req, res, next) => {
  try {
    if (!requireAdminFeature(req, res)) return hidden(req, res);
    const page = parseListQuery(req.query, { status: (value) => ['pending', 'verified', 'disabled', 'conflict'].includes(value) });
    if (!page) return invalid(req, res);
    const result = await withAudit(pool, req, 'solides.links.read', 'solides_link', async (client) => {
      const values = [];
      const where = req.query.status ? 'WHERE l.status = $1' : '';
      if (req.query.status) values.push(req.query.status);
      const offsetPosition = values.push(page.offset);
      const limitPosition = values.push(page.limit);
      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        client.query(`SELECT l.user_uid, l.employee_id::text, l.external_id, l.employer_scope, l.status,
          l.matched_by, l.verified_at, l.last_seen_at, l.updated_at, u.name, u.email
          FROM solides_employee_links l JOIN users u ON u.uid = l.user_uid ${where}
          ORDER BY l.updated_at DESC, l.user_uid LIMIT $${limitPosition} OFFSET $${offsetPosition}`, values),
        client.query(`SELECT COUNT(*)::int AS total FROM solides_employee_links l ${where}`, req.query.status ? [req.query.status] : []),
      ]);
      return { rows, total };
    }, { targetId: 'list', details: (result) => ({ count: result.rows.length }) });
    res.setHeader('X-Total-Count', result.total);
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.put('/admin/links/:uid', authMiddleware, async (req, res, next) => {
  try {
    const config = requireAdminFeature(req, res);
    if (!config) return hidden(req, res);
    if (!req.params.uid || req.params.uid.length > 128 || !validBody(req.body, {
      employeeId: positiveBigInt,
      externalId: (value) => value === null || text(200)(value),
      employerScope: oneOf('default'),
      status: oneOf('pending', 'verified', 'disabled', 'conflict'),
      matchedBy: oneOf('manual', 'external_id'),
    }, ['employeeId', 'employerScope', 'status', 'matchedBy'])) return invalid(req, res);
    if (req.body.matchedBy === 'external_id' && !req.body.externalId) return invalid(req, res);

    const link = await withAudit(pool, req, 'solides.link.upsert', 'solides_link', async (client) => {
      const { rows: [existing] } = await client.query(
        'SELECT employee_id::text FROM solides_employee_links WHERE user_uid = $1 FOR UPDATE', [req.params.uid]
      );
      if (!verificationTransitionAllowed(existing, req.body.employeeId, req.body.status)) {
        const error = new Error('Save the employee link as pending before verification.');
        error.code = 'SOLIDES_VERIFICATION_REQUIRED';
        throw error;
      }
      if (req.body.status === 'verified') {
        const employee = await solidesJson('employer', 'employee/find', {
          config, query: { tangerinoId: req.body.employeeId, ignoreFired: false },
        });
        if (!employeeMatchesLink(employee, req.body.employeeId, req.body.externalId)) {
          const error = new Error('Sólides employee does not match the pending link.');
          error.code = 'SOLIDES_EMPLOYEE_MISMATCH';
          throw error;
        }
      }
      const { rows: [saved] } = await client.query(
        `INSERT INTO solides_employee_links
          (user_uid, employee_id, external_id, employer_scope, status, matched_by, verified_by, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'verified' THEN $7 ELSE NULL END,
          CASE WHEN $5 = 'verified' THEN NOW() ELSE NULL END)
         ON CONFLICT (user_uid) DO UPDATE SET employee_id = EXCLUDED.employee_id,
          external_id = EXCLUDED.external_id, employer_scope = EXCLUDED.employer_scope,
          status = EXCLUDED.status, matched_by = EXCLUDED.matched_by,
          verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at, updated_at = NOW()
         RETURNING user_uid, employee_id::text, external_id, employer_scope, status, matched_by, verified_at, updated_at`,
        [req.params.uid, req.body.employeeId, req.body.externalId || null, req.body.employerScope.trim(), req.body.status, req.body.matchedBy, req.user.uid]
      );
      return saved;
    }, { targetId: req.params.uid, details: (saved) => ({ status: saved.status, matchedBy: saved.matched_by }) });
    res.json(link);
  } catch (error) {
    if (['SOLIDES_VERIFICATION_REQUIRED', 'SOLIDES_EMPLOYEE_MISMATCH'].includes(error.code)) {
      return res.status(409).json({ error: error.message, requestId: req.id });
    }
    if (error.code === '23503') return res.status(404).json({ error: 'User not found.', requestId: req.id });
    if (error.code === '23505') return res.status(409).json({ error: 'Sólides employee is already linked.', requestId: req.id });
    upstreamFailure(error, req, res, next);
  }
});

router.delete('/admin/links/:uid', authMiddleware, async (req, res, next) => {
  try {
    if (!requireAdminFeature(req, res)) return hidden(req, res);
    if (!req.params.uid || req.params.uid.length > 128) return invalid(req, res);
    const deleted = await withAudit(pool, req, 'solides.link.delete', 'solides_link', async (client) => {
      const { rows: [row] } = await client.query(
        'DELETE FROM solides_employee_links WHERE user_uid = $1 RETURNING user_uid', [req.params.uid]
      );
      return row;
    }, { targetId: req.params.uid });
    if (!deleted) return res.status(404).json({ error: 'Sólides link not found.', requestId: req.id });
    res.status(204).end();
  } catch (error) { next(error); }
});

module.exports = router;
module.exports._test = { adjustmentEmployeeId, asArray, dateRange, employeeMatchesLink, finiteNumber, isoTimestamp, normalizeAdjustment, normalizeEmployee, normalizePunch, normalizeSummary, positiveBigInt, shiftTime, verificationTransitionAllowed };
