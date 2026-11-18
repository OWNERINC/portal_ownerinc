const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { importDocuments } = require('../api/knowledge/import');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--apply')) {
    throw new Error('Usage: node scripts/import-knowledge-documents.cjs PACKAGE_DIRECTORY BATCH [--apply]');
  }
  const uploadDir = path.resolve(args[0]);
  const { version, articles } = JSON.parse(await readFile(path.join(uploadDir, 'import.json'), 'utf8'));
  if (version !== 1) throw new Error('Unsupported import format');
  const pool = require('../api/db');
  try {
    console.log(JSON.stringify(await importDocuments({ pool, uploadDir, articles, batch: args[1], apply: args[2] === '--apply' }), null, 2));
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
