import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { applyBundle, BundleImportError } from './lib/owner-news-bundle-import.mjs';
import { privatePath, serializeBundle } from './lib/owner-news-bundle.mjs';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const fail = code => { throw new BundleImportError(code); };
export async function main(args = process.argv.slice(2), env = process.env) {
  const options = {}; let mode = 'dry-run', selected = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--dry-run', '--apply-draft', '--publish'].includes(arg)) {
      if (selected) fail('invalid_arguments'); selected = true; mode = arg.slice(2);
    } else if (['--bundle', '--target-output'].includes(arg)) {
      if (options[arg] || !args[index + 1] || args[index + 1].startsWith('--')) fail('invalid_arguments');
      options[arg] = args[++index];
    } else fail('invalid_arguments');
  }
  if (!options['--bundle'] || !path.isAbsolute(options['--bundle'])
    || options['--target-output'] && (mode !== 'dry-run' || !path.isAbsolute(options['--target-output'])
      || path.dirname(options['--target-output']) !== path.dirname(options['--bundle']))) fail('invalid_arguments');
  await privatePath(options['--bundle'], { existing: true });
  if (options['--target-output']) await privatePath(options['--target-output']);
  const connectionString = env.OWNER_NEWS_TARGET_DATABASE_URL;
  let url;
  try { url = new URL(connectionString); } catch { fail('explicit_database_required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1) || url.search || url.hash) fail('invalid_database_configuration');
  if (!env.OWNER_NEWS_TARGET_UPLOAD_DIR || !env.OWNER_NEWS_ACTOR_UID) fail('explicit_destination_required');
  const stat = await fs.stat(options['--bundle']);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('invalid_manifest');
  const bundleBytes = await fs.readFile(options['--bundle']);
  let bundle;
  try { bundle = JSON.parse(bundleBytes.toString('utf8')); } catch { fail('invalid_manifest'); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const report = await applyBundle({ pool, bundle, bundleBytes, root: path.dirname(options['--bundle']),
      uploadDir: env.OWNER_NEWS_TARGET_UPLOAD_DIR, actorUid: env.OWNER_NEWS_ACTOR_UID, mode });
    if (options['--target-output']) {
      // Reconciliation proposes snapshots only for unmapped prior identities. Never rebase
      // an approved target or replace its original expectations after applying a draft.
      for (const item of bundle.items) {
        const candidate = report.targets.find(t => t.key === item.key);
        if (item.target === null && candidate?.target && !candidate.change?.startsWith('existing_')) item.target = candidate.target;
      }
      await fs.writeFile(options['--target-output'], serializeBundle(bundle), { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(report));
    if (report.conflicts.length) process.exitCode = 1;
    return report;
  } finally { await pool.end(); }
}

export function safeImportError(error) {
  if (error?.code === 'news_read_only' || error?.code === 'news_authority_unavailable') {
    return { error: 'Importação bloqueada', reason: error.code };
  }
  const codes = new Set(['invalid_arguments', 'explicit_database_required', 'invalid_database_configuration',
    'explicit_destination_required', 'invalid_manifest', 'review_required', 'invalid_actor', 'invalid_database_role',
    'target_conflict', 'prepared_draft_required', 'prepared_bundle_required', 'verification_failed', 'commit_outcome_unknown']);
  return { error: 'Importação bloqueada', reason: error instanceof BundleImportError && codes.has(error.code) ? error.code : 'import_failed' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify(safeImportError(error))); process.exitCode = 1; });
}
