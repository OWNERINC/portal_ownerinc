class PollError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const unsafeText = /<\/?[a-z][^>]*>|\bon[a-z]+\s*=|javascript\s*:/i;
function normalizePollDraft(value) {
  const limits = { title: 80, question: 240, description: 600, closing: 200 };
  const allowed = new Set([...Object.keys(limits), 'options']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.has(key))) return null;
  const next = {};
  for (const [key, max] of Object.entries(limits)) {
    if (typeof value[key] !== 'string' || value[key].trim().length > max || unsafeText.test(value[key])) return null;
    next[key] = value[key].trim();
  }
  if (!next.title || !next.question || !Array.isArray(value.options)
    || value.options.length < 2 || value.options.length > 6) return null;
  if (!value.options.every(label => typeof label === 'string' && label.trim()
    && label.trim().length <= 100 && !/[\r\n]/.test(label) && !unsafeText.test(label))) return null;
  next.options = value.options.map(label => label.trim());
  const keys = next.options.map(label => label.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' '));
  return new Set(keys).size === keys.length ? next : null;
}

// A DTO's options, counts and viewer choice always come from one SQL snapshot.
const projection = `SELECT p.id,p.title,p.question,p.description,p.closing,p.status,p.version,
  COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'label',o.label,
    'votes',(SELECT COUNT(*) FROM owner_news_poll_votes v WHERE v.poll_id=p.id AND v.option_id=o.id))
    ORDER BY o.position) FILTER (WHERE o.id IS NOT NULL),'[]'::jsonb) AS options,
  (SELECT v.option_id FROM owner_news_poll_votes v WHERE v.poll_id=p.id AND v.user_uid=$2) AS viewer_option_id
  FROM owner_news_polls p LEFT JOIN owner_news_poll_options o ON o.poll_id=p.id`;
function toDTO(row) {
  const options = row.options.map(({ id, label, votes }) => ({ id, label, votes: Number(votes) }));
  const total = options.reduce((sum, option) => sum + option.votes, 0);
  return {
    id: row.id, title: row.title, question: row.question, description: row.description,
    closing: row.closing, status: row.status, version: row.version,
    options: options.map(option => ({ ...option, percentage: total ? Math.round(option.votes / total * 100) : 0 })),
    total_votes: total, viewer_option_id: row.viewer_option_id,
  };
}
async function readPoll(db, id, viewerUid, { includeDraft = false } = {}) {
  const { rows } = await db.query(`${projection}
    WHERE p.id=$1 AND (p.status<>'draft' OR $3::boolean) GROUP BY p.id`, [id, viewerUid, includeDraft]);
  return rows[0] ? toDTO(rows[0]) : null;
}
async function readCurrentPoll(db, viewerUid) {
  const { rows } = await db.query(`${projection}
    WHERE p.id=(SELECT id FROM owner_news_polls WHERE status<>$1
      ORDER BY (status='open') DESC, published_at DESC NULLS LAST, id LIMIT 1)
    GROUP BY p.id`, ['draft', viewerUid]);
  return rows[0] ? toDTO(rows[0]) : null;
}
async function listPolls(db, viewerUid, { limit = 50, offset = 0, status } = {}) {
  // The envelope also preserves count when the requested page is empty.
  const { rows: [result] } = await db.query(`WITH filtered AS (
      SELECT * FROM owner_news_polls WHERE ($1::text IS NULL OR status=$1)
    ), page AS (SELECT id FROM filtered ORDER BY created_at DESC,id LIMIT $3 OFFSET $4),
    projected AS (${projection} WHERE p.id IN (SELECT id FROM page) GROUP BY p.id)
    SELECT (SELECT COUNT(*) FROM filtered)::integer AS count,
      COALESCE((SELECT jsonb_agg(to_jsonb(projected) ORDER BY p.created_at DESC,p.id)
        FROM projected JOIN owner_news_polls p USING(id)), '[]'::jsonb) AS rows`, [status || null, viewerUid, limit, offset]);
  return { count: result.count, rows: result.rows.map(toDTO) };
}

function draftOrThrow(content) {
  const normalized = normalizePollDraft(content);
  if (!normalized) throw new PollError(400, 'invalid_poll');
  return normalized;
}
async function insertOptions(db, id, labels) {
  await db.query(`INSERT INTO owner_news_poll_options(poll_id,label,position)
    SELECT $1,label,(ordinality-1)::integer FROM unnest($2::text[]) WITH ORDINALITY AS options(label,ordinality)`, [id, labels]);
}
// Mutations receive the client inside withAudit's transaction, never a pool.
async function lockedPoll(db, id, expectedVersion) {
  const { rows: [poll] } = await db.query('SELECT * FROM owner_news_polls WHERE id=$1 FOR UPDATE', [id]);
  if (!poll) throw new PollError(404, 'poll_not_found');
  if (poll.version !== expectedVersion) throw new PollError(409, 'version_conflict');
  return poll;
}
async function createPollDraft(db, content, actorUid) {
  const next = draftOrThrow(content);
  const { rows: [poll] } = await db.query(`INSERT INTO owner_news_polls(title,question,description,closing,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`, [next.title, next.question, next.description, next.closing, actorUid]);
  await insertOptions(db, poll.id, next.options);
  return readPoll(db, poll.id, actorUid, { includeDraft: true });
}
async function updatePollDraft(db, id, content, expectedVersion, actorUid) {
  const next = draftOrThrow(content);
  const poll = await lockedPoll(db, id, expectedVersion);
  if (poll.status !== 'draft') throw new PollError(409, 'poll_frozen');
  await db.query(`UPDATE owner_news_polls SET title=$2,question=$3,description=$4,closing=$5,
    updated_by=$6,updated_at=NOW(),version=version+1 WHERE id=$1`, [id, next.title, next.question, next.description, next.closing, actorUid]);
  await db.query('DELETE FROM owner_news_poll_options WHERE poll_id=$1', [id]);
  await insertOptions(db, id, next.options);
  return readPoll(db, id, actorUid, { includeDraft: true });
}
async function publishPoll(db, id, expectedVersion, actorUid) {
  const poll = await lockedPoll(db, id, expectedVersion);
  if (poll.status !== 'draft') throw new PollError(409, 'poll_frozen');
  const { rows } = await db.query('SELECT label FROM owner_news_poll_options WHERE poll_id=$1 ORDER BY position', [id]);
  draftOrThrow({ title: poll.title, question: poll.question, description: poll.description, closing: poll.closing, options: rows.map(row => row.label) });
  // Let the unique-index error escape. The route translates it only after rollback.
  await db.query(`UPDATE owner_news_polls SET status='open',published_at=NOW(),
    updated_at=NOW(),updated_by=$2,version=version+1 WHERE id=$1`, [id, actorUid]);
  return readPoll(db, id, actorUid);
}
async function closePoll(db, id, expectedVersion, actorUid) {
  const poll = await lockedPoll(db, id, expectedVersion);
  if (poll.status !== 'open') throw new PollError(409, 'poll_not_open');
  await db.query(`UPDATE owner_news_polls SET status='closed',closed_at=NOW(),
    updated_at=NOW(),updated_by=$2,version=version+1 WHERE id=$1`, [id, actorUid]);
  return readPoll(db, id, actorUid);
}
async function voteOnPoll(db, id, optionId, viewerUid) {
  const { rows: [poll] } = await db.query('SELECT id,status FROM owner_news_polls WHERE id=$1 FOR UPDATE', [id]);
  if (!poll || poll.status === 'draft') throw new PollError(404, 'poll_not_found');
  const { rows: [previous] } = await db.query('SELECT option_id FROM owner_news_poll_votes WHERE poll_id=$1 AND user_uid=$2', [id, viewerUid]);
  if (previous) {
    if (previous.option_id !== optionId) throw new PollError(409, 'already_voted');
    return { poll: await readPoll(db, id, viewerUid), recorded: false };
  }
  if (poll.status !== 'open') throw new PollError(409, 'poll_closed');
  const { rows } = await db.query('SELECT id FROM owner_news_poll_options WHERE poll_id=$1 AND id=$2', [id, optionId]);
  if (!rows[0]) throw new PollError(400, 'invalid_option');
  await db.query('INSERT INTO owner_news_poll_votes(poll_id,option_id,user_uid) VALUES ($1,$2,$3)', [id, optionId, viewerUid]);
  return { poll: await readPoll(db, id, viewerUid), recorded: true };
}

module.exports = { PollError, normalizePollDraft, createPollDraft, updatePollDraft, publishPoll, closePoll, readPoll, readCurrentPoll, listPolls, voteOnPoll };
