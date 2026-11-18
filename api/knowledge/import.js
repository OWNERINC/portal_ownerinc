const { isDeepStrictEqual } = require('node:util');
const { validateDescriptor, loadDocument, documentImage } = require('./documents');
const { uuid } = require('../route-utils');

function sameArticle(row, article) {
  return ['id','title','category','content'].every(key => row[key] === article[key])
    && isDeepStrictEqual(row.document, article.document);
}
async function validateArticles(articles, uploadDir) {
  if (!Array.isArray(articles) || !articles.length || articles.length > 100) throw new Error('Invalid article batch');
  const ids = new Set(), titles = new Set();
  for (const article of articles) {
    if (!article || Object.keys(article).sort().join(',') !== 'category,content,document,id,title'
      || !uuid(article.id) || ids.has(article.id)
      || typeof article.title !== 'string' || !article.title.trim() || article.title.length > 200
      || titles.has(article.title)
      || typeof article.category !== 'string' || article.category.length > 100
      || typeof article.content !== 'string' || article.content.length > 50000
      || !article.document || !validateDescriptor(article.document)) throw new Error('Invalid article batch');
    ids.add(article.id); titles.add(article.title);
    if (article.document.kind === 'pdf') {
      const manifest = await loadDocument(uploadDir, article.document);
      await documentImage(uploadDir, article.document, 'cover');
      for (const page of manifest.pages) await documentImage(uploadDir, article.document, String(page.number));
    }
  }
}
async function importDocuments({ pool, uploadDir, articles, batch, apply = false }) {
  if (typeof batch !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(batch)) throw new Error('Invalid batch identity');
  await validateArticles(articles, uploadDir);
  const client = await pool.connect();
  let attemptedCommit = false, released = false, discard = false;
  const ids = articles.map(article => article.id);
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    if (apply) await client.query('LOCK TABLE knowledge_base IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query(
      `SELECT id,title,category,content,document FROM knowledge_base
       WHERE id=ANY($1::uuid[]) OR title=ANY($2::text[])
       OR document->>'key'=ANY($3::text[]) OR document->>'kind'='ethics'`,
      [ids, articles.map(a => a.title), articles.filter(a => a.document.kind === 'pdf').map(a => a.document.key)]);
    for (const row of rows) {
      const expected = articles.find(article => article.id === row.id);
      if (!expected || !sameArticle(row, expected)) throw new Error(`Article conflict: ${row.id}`);
    }
    const missing = articles.filter(article => !rows.some(row => row.id === article.id));
    const previous = await client.query("SELECT details FROM audit_log WHERE action='knowledge.documents_import' AND request_id=$1", [batch]);
    if (previous.rows.length && (missing.length || previous.rows.length !== 1
      || !isDeepStrictEqual(previous.rows[0].details.ids, ids))) throw new Error('Batch identity already used for a different result');
    if (apply && missing.length) {
      for (const article of missing) {
        await client.query(`INSERT INTO knowledge_base(id,title,category,content,document,created_by)
          VALUES($1,$2,$3,$4,$5::jsonb,NULL)`, [
          article.id, article.title, article.category, article.content, JSON.stringify(article.document),
        ]);
      }
      await client.query(`INSERT INTO audit_log(actor_uid,action,target_type,target_id,request_id,details)
        VALUES(NULL,'knowledge.documents_import','knowledge',$1,$1,$2::jsonb)`,
      [batch, JSON.stringify({ ids, created: missing.map(a => a.id),
        documents: articles.map(a => ({ id: a.id, ...a.document })) })]);
    }
    attemptedCommit = true;
    await client.query('COMMIT');
    return { batch, applied: apply, created: apply ? missing.length : 0, wouldCreate: missing.length,
      unchanged: rows.length, ids };
  } catch (error) {
    if (!attemptedCommit) await client.query('ROLLBACK').catch(() => { discard = true; });
    else discard = true;
    if (attemptedCommit && apply) {
      client.release(true); released = true;
      // A lost COMMIT reply is reconciled on a different connection, never replayed blindly.
      const result = await pool.query('SELECT id,title,category,content,document FROM knowledge_base WHERE id=ANY($1::uuid[])', [ids]);
      const audit = await pool.query("SELECT details FROM audit_log WHERE action='knowledge.documents_import' AND request_id=$1", [batch]);
      if (result.rows.length === articles.length && articles.every(a => result.rows.some(row => sameArticle(row, a)))
        && audit.rows.length === 1 && isDeepStrictEqual(audit.rows[0].details.ids, ids)) {
        return { batch, applied: true, reconciled: true, ids };
      }
      error.commitAmbiguous = true;
    }
    throw error;
  } finally { if (!released) client.release(discard); }
}
module.exports = { importDocuments, validateArticles, sameArticle };
