import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBundle, validateBundleAsset, serializeBundle, bundleHashes, privatePath } from './lib/owner-news-bundle.mjs';

// Exact internal messages only: never interpolate exception text, paths or upstream bodies.
const SAFE_ERRORS = new Map([
  ['Bundle exceeds 300 MiB asset budget', ['asset_budget_exceeded', 'o pacote excede o limite de 300 MiB de assets.']],
  ...['Item needs_review', 'Approved item has unresolved review issues'].map(message =>
    [message, ['review_required', 'há itens ou ocorrências que exigem revisão editorial.']]),
  ...['Invalid manifest JSON', 'Invalid bundle schema', 'Invalid source snapshot', 'Invalid source inventory',
    'Invalid or duplicate decision', 'Missing source decision', 'Invalid pending sources',
    'Invalid item/action/key', 'Missing source provenance', 'Invalid source provenance',
    'Inconsistent/duplicate source decision', 'Invalid target snapshot', 'Invalid item metadata',
    'Invalid editorial revision', 'Invalid CMS editorial revision', 'Unknown asset_key',
    'Decision missing canonical item', 'Unreferenced bundle asset', 'Duplicate asset_key'].map(message =>
    [message, ['invalid_manifest', 'o manifesto contém JSON, campos, decisões ou referências inválidos.']]),
  ['Editorial payload exceeds 5 MiB', ['editorial_payload_exceeded', 'uma revisão excede o limite de 5 MiB.']],
]);

export function preparationErrorMessage(error) {
  const [code, message] = SAFE_ERRORS.get(error?.message)
    || ['preparation_failed', 'confira manifesto, pendências e arquivos privados.'];
  return `Preparação bloqueada [${code}]: ${message}`;
}

export async function main(args = process.argv.slice(2)) {
  const opts = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--input', '--output', '--check', '--allow-pending'].includes(arg) || arg in opts) throw new Error('Invalid preparation arguments');
    opts[arg] = ['--input', '--output'].includes(arg) ? args[++index] : true;
  }
  if (!opts['--input'] || (!opts['--check'] && !opts['--output']) || opts['--check'] && opts['--output']) throw new Error('Use --input absolute.json (--output absolute-directory | --check) [--allow-pending]');
  const input = await privatePath(opts['--input'], { existing: true });
  const root = path.dirname(input), inputBytes = await fs.readFile(input);
  let original;
  try { original = JSON.parse(inputBytes.toString('utf8')); }
  catch { throw new Error('Invalid manifest JSON'); }
  const bundle = await validateBundle(original, { root, allowPending: Boolean(opts['--allow-pending']) });
  if (!opts['--check']) {
    const output = await privatePath(opts['--output']);
    // Exclusive directory creation makes crash leftovers visible; never overwrite them.
    await fs.mkdir(output, { mode: 0o700 });
    await fs.mkdir(path.join(output, 'assets'), { mode: 0o700 });
    for (const asset of bundle.assets) {
      const { buffer } = await validateBundleAsset(asset, { root });
      const file = path.join(output, asset.relative_path);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try { await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST' || !(await fs.readFile(file)).equals(buffer)) throw error; }
    }
    await validateBundle(bundle, { root: output, allowPending: Boolean(opts['--allow-pending']) });
    await fs.writeFile(path.join(output, 'bundle.json'), serializeBundle(bundle), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report(bundle, false), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const result = report(bundle, Boolean(opts['--check']));
  if (opts['--check']) result.bundle_sha256 = createHash('sha256').update(inputBytes).digest('hex');
  return result;
}

function report(bundle, check) {
  return { mode: check ? 'check' : 'prepare', ...bundleHashes(bundle), items: bundle.items.length,
    needs_review: bundle.items.filter(i => i.review_status === 'needs_review').length,
    pending_sources: bundle.source_snapshot.pending_sources?.length || 0,
    assets: bundle.assets.length, bytes: bundle.assets.reduce((sum, a) => sum + a.byte_size, 0),
    complete_corpus: bundle.source_snapshot.edition_pdf_sha256 !== null && !bundle.source_snapshot.pending_sources?.length,
    drafts_applied: 0, publications: 0, destination_assets_verified: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    // Source text, filesystem paths and upstream error bodies stay private.
    console.error(preparationErrorMessage(error)); process.exitCode = 1;
  });
}
