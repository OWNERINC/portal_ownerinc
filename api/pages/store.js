const { createHash, randomUUID } = require('node:crypto');
const { PagesError, validateDocument } = require('./validation');
const { createTemplate } = require('./templates');
const { editor, publisher, mayEdit, mayReview, capabilities } = require('./access');

const error = (status, reason) => { throw new PagesError(status, reason); };
function canonical(value, depth = 0) {
  if (depth > 40) error(400, 'invalid_document');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
async function pageRow(db, id, lock = false) {
  const { rows } = await db.query(`SELECT * FROM pages WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) error(404, 'not_visible'); return rows[0];
}
async function workspace(db, user, id) {
  const { rows } = await db.query(`SELECT p.*, row_to_json(d) AS draft, row_to_json(r) AS published
    FROM pages p JOIN page_revisions d ON d.id = p.draft_revision_id AND d.page_id = p.id
    LEFT JOIN page_revisions r ON r.id = p.published_revision_id AND r.page_id = p.id WHERE p.id = $1`, [id]);
  const p = rows[0]; if (!p) error(404, 'not_visible'); if (!mayReview(user, p)) error(403, 'permission_denied');
  const revision = r => r ? { id: r.id, document: r.document, created_at: r.created_at } : null;
  return { id: p.id, author_uid: p.author_uid, version: p.version, draft_revision_id: p.draft_revision_id,
    published_revision_id: p.published_revision_id, archived_at: p.archived_at,
    draft: revision(p.draft), published: revision(p.published), capabilities: capabilities(user, p) };
}
async function references(db, pageId, validated, publishing = false) {
  const cargos = await db.query('SELECT id, active FROM job_titles WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [validated.jobTitleIds]);
  if (cargos.rows.length !== validated.jobTitleIds.length || (publishing && cargos.rows.some(row => row.active !== true))) error(400, 'invalid_audience');
  const media = await db.query('SELECT id,kind,duration_ms FROM page_media WHERE page_id = $1 AND id = ANY($2::uuid[])', [pageId, validated.mediaIds]);
  if (media.rows.length !== validated.mediaIds.length || validated.mediaRefs.some(ref => !media.rows.some(row => row.id === ref.id && row.kind === ref.kind))) error(400, 'media_not_ready');
  for (const section of validated.document.sections) for (const row of section.rows) for (const col of row.columns) for (const block of col.blocks) {
    if (block.captions?.some(cue => cue.end_ms > Number(media.rows.find(item => item.id === block.media_id)?.duration_ms))) error(400, 'invalid_media_cues');
  }
}
async function insertRevision(db, user, pageId, validated) {
  const id = randomUUID(), document = validated.document;
  await db.query(`INSERT INTO page_revisions(id,page_id,schema_version,title,document,audience,created_by)
    VALUES($1,$2,$6,$3,$4::jsonb,'job_titles',$5)`, [id, pageId, document.metadata.title, JSON.stringify(document), user.uid, document.schema_version]);
  for (const cargo of validated.jobTitleIds) await db.query('INSERT INTO page_revision_job_titles(revision_id,job_title_id) VALUES($1,$2)', [id, cargo]);
  for (const media of validated.mediaIds) await db.query('INSERT INTO page_revision_media(page_id,revision_id,media_id) VALUES($1,$2,$3)', [pageId, id, media]);
  return id;
}

// One checked-out client owns locking, CAS, revision, projections, audit and replay.
// A committed retry is authorized again, but never re-applies expected_version.
async function mutate(pool, req, operation, targetId, body, media = null) {
  if ((['create','draft','media'].includes(operation) && !editor(req.user)) || (['publish','archive','restore'].includes(operation) && !publisher(req.user))) error(403, 'permission_denied');
  const db = await pool.connect(); let commitStarted = false, discard;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pages:${req.user.uid}:${body.client_mutation_id}`]);
    const requestHash = hash({ operation, targetId, payload: body });
    const previous = (await db.query('SELECT * FROM page_requests WHERE actor_uid = $1 AND client_mutation_id = $2', [req.user.uid, body.client_mutation_id])).rows[0];
    const pageId = operation === 'create' ? (previous?.target_id || randomUUID()) : targetId;
    let page = null;
    if (operation !== 'create' || previous) {
      page = await pageRow(db, pageId, true);
      if (['create','draft','media'].includes(operation) && !mayEdit(req.user, page)) error(403, 'author_only');
    }
    if (previous) {
      if (previous.request_hash !== requestHash || previous.operation !== operation) error(409, 'mutation_conflict');
      commitStarted = true; await db.query('COMMIT');
      return { status: previous.status, ack: previous.response, replay: true };
    }
    if (page && operation !== 'restore' && page.archived_at) error(409, 'page_archived');
    if (page && operation !== 'media' && page.version !== body.expected_version) error(409, 'version_conflict');
    let ack;
    if (operation === 'create') {
      await db.query('INSERT INTO pages(id,author_uid) VALUES($1,$2)', [pageId, req.user.uid]);
      const revisionId = await insertRevision(db, req.user, pageId, validateDocument(createTemplate(body.template_id)));
      page = (await db.query('UPDATE pages SET draft_revision_id = $2 WHERE id = $1 RETURNING *', [pageId, revisionId])).rows[0];
    } else if (operation === 'draft') {
      const validated = validateDocument(body.document);
      await references(db, pageId, validated);
      const revisionId = await insertRevision(db, req.user, pageId, validated);
      page = (await db.query('UPDATE pages SET draft_revision_id = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [pageId, revisionId])).rows[0];
    } else if (operation === 'publish') {
      if (page.draft_revision_id !== body.revision_id.toLowerCase()) error(409, 'version_conflict');
      const revision = (await db.query('SELECT document FROM page_revisions WHERE page_id = $1 AND id = $2', [pageId, body.revision_id])).rows[0];
      const validated = validateDocument(revision.document, { publishing: true });
      await references(db, pageId, validated, true);
      page = (await db.query('UPDATE pages SET published_revision_id = $2, published_at = now(), published_by = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [pageId, body.revision_id, req.user.uid])).rows[0];
    } else if (operation === 'archive' || operation === 'restore') {
      if (operation === 'restore' && !page.archived_at) error(409, 'not_archived');
      page = (await db.query(`UPDATE pages SET archived_at = ${operation === 'archive' ? 'now()' : 'NULL'}, published_revision_id = NULL,
        published_at = NULL, published_by = NULL, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [pageId])).rows[0];
    } else if (operation === 'media') {
      const quota = (await db.query('SELECT count(*)::integer AS count, COALESCE(sum(byte_size),0)::bigint AS bytes FROM page_media WHERE page_id = $1', [pageId])).rows[0];
      if (quota.count >= 50 || Number(quota.bytes) + media.byte_size > 100 * 1024 * 1024) error(413, 'page_media_quota');
      await db.query(`INSERT INTO page_media(id,page_id,uploaded_by,storage_key,mime_type,byte_size,width,height,sha256,kind,duration_ms,frame_count)
        VALUES($1,$2,$3,$4,$9,$5,$6,$7,$8,$10,$11,$12)`, [media.id, pageId, req.user.uid, media.storage_key, media.byte_size, media.width, media.height, media.sha256, media.mime_type || 'image/webp', media.kind || 'image', media.duration_seconds == null ? null : Math.round(media.duration_seconds * 1000), media.frame_count ?? null]);
      ack = { id: media.id, page_id: pageId, media_id: media.id, kind: media.kind || 'image', mime_type: media.mime_type || 'image/webp', width: media.width, height: media.height, byte_size: media.byte_size, duration_ms: media.duration_seconds == null ? null : Math.round(media.duration_seconds * 1000) };
    }
    ack ||= { id: pageId, version: page.version, draft_revision_id: page.draft_revision_id, published_revision_id: page.published_revision_id };
    const status = operation === 'create' || operation === 'media' ? 201 : 200;
    await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,target_id,request_id,details) VALUES($1,$2,'pages',$3,$4,$5::jsonb)`,
      [req.user.uid, `pages.${operation}`, pageId, req.id || null, JSON.stringify({ version: page.version, ...(media ? { media_id: ack.media_id } : {}) })]);
    await db.query(`INSERT INTO page_requests(actor_uid,client_mutation_id,operation,target_id,request_hash,response,status)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [req.user.uid, body.client_mutation_id, operation, pageId, requestHash, JSON.stringify(ack), status]);
    commitStarted = true;
    await db.query('COMMIT');
    return { status, ack, replay: false };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    if (commitStarted) discard = err;
    err.commitAmbiguous = commitStarted; throw err;
  } finally { db.release(discard); }
}

// Current account and active cargo are resolved inside the same statement as the
// publication head. Admin status never broadens a normal read.
const eligible = `p.archived_at IS NULL AND p.published_revision_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM users u JOIN job_titles jt ON jt.id = u.job_title_id AND jt.active = TRUE
  JOIN page_revision_job_titles a ON a.job_title_id = jt.id AND a.revision_id = p.published_revision_id WHERE u.uid = $1)`;
async function reader(db, user, id) {
  const { rows } = await db.query(`SELECT p.id,r.id AS revision_id,r.document,p.published_at FROM pages p
    JOIN page_revisions r ON r.id = p.published_revision_id AND r.page_id = p.id WHERE p.id = $2 AND ${eligible}`, [user.uid, id]);
  if (!rows[0]) error(404, 'not_visible'); return rows[0];
}
async function preview(db, user, id, revisionId) {
  const { rows } = await db.query(`SELECT p.author_uid,p.archived_at,p.id,r.id AS revision_id,r.document,p.published_at FROM pages p
    JOIN page_revisions r ON r.page_id = p.id AND r.id = COALESCE($2::uuid,p.draft_revision_id) WHERE p.id = $1`, [id, revisionId || null]);
  const row = rows[0]; if (!row || !mayReview(user, row) || row.archived_at) error(404, 'not_visible');
  return { id: row.id, revision_id: row.revision_id, document: row.document, published_at: row.published_at };
}
async function list(db, user, query, management = false) {
  if (management && !editor(user) && !publisher(user)) error(403, 'permission_denied');
  const values = [user.uid, query.q || '', query.tag || '', query.limit, query.offset];
  if (management) values.push(publisher(user));
  const condition = management ? '($6::boolean OR p.author_uid = $1)' : eligible;
  const revision = management ? 'draft_revision_id' : 'published_revision_id';
  const result = await db.query(`WITH visible AS (
    SELECT p.id,r.id AS revision_id,r.title,r.document->'metadata'->>'summary' AS summary,
      r.document->'metadata'->'tags' AS tags,p.version,p.archived_at,p.published_at,p.author_uid
    FROM pages p JOIN page_revisions r ON r.id = p.${revision} AND r.page_id = p.id
    WHERE ${condition} AND ($2 = '' OR r.title ILIKE '%' || $2 || '%')
      AND ($3 = '' OR (r.document->'metadata'->'tags') ? $3)
  ), selected AS (SELECT * FROM visible ORDER BY published_at DESC NULLS LAST,id LIMIT $4 OFFSET $5)
  SELECT (SELECT count(*)::integer FROM visible) AS total, COALESCE((SELECT json_agg(selected) FROM selected),'[]'::json) AS items`, values);
  return result.rows[0];
}
async function mediaRecord(db, user, pageId, mediaId, { revisionId, staged = false } = {}) {
  let result;
  if (staged) {
    result = await db.query(`SELECT m.*,p.author_uid,p.archived_at FROM page_media m JOIN pages p ON p.id = m.page_id
      WHERE m.page_id = $1 AND m.id = $2 AND p.archived_at IS NULL`, [pageId, mediaId]);
    if (!result.rows[0] || !mayEdit(user, result.rows[0])) error(404, 'not_visible');
  } else if (revisionId) {
    result = await db.query(`SELECT m.*,p.author_uid,p.archived_at FROM pages p JOIN page_revision_media rm ON rm.page_id = p.id AND rm.revision_id = $3
      JOIN page_media m ON m.page_id = rm.page_id AND m.id = rm.media_id
      WHERE p.id = $1 AND m.id = $2 AND p.archived_at IS NULL`, [pageId, mediaId, revisionId]);
    if (!result.rows[0] || !mayReview(user, result.rows[0])) error(404, 'not_visible');
  } else {
    result = await db.query(`SELECT m.* FROM pages p JOIN page_revision_media rm ON rm.page_id = p.id AND rm.revision_id = p.published_revision_id
      JOIN page_media m ON m.page_id = p.id AND m.id = rm.media_id WHERE p.id = $2 AND m.id = $3 AND ${eligible}`, [user.uid, pageId, mediaId]);
    if (!result.rows[0]) error(404, 'not_visible');
  }
  return result.rows[0];
}
module.exports = { canonical, hash, pageRow, workspace, mutate, reader, preview, list, mediaRecord };
