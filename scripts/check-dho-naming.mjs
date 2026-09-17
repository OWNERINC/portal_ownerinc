import { readFile, readdir } from 'node:fs/promises';

const forbiddenLegacyName = /(^|[^\p{L}\p{N}_])RH([^\p{L}\p{N}_]|$)/iu;
const publicRoot = new URL('../public/', import.meta.url);
const migrationsRoot = new URL('../api/db/migrations/', import.meta.url);
const migrationUrl = new URL('../api/db/migrations/030_dho_job_title_catalog.sql', import.meta.url);
const migrationFilename = /^\d+_[a-z0-9_]+\.sql$/;
const legacyStartMarker = '-- legacy-job-title-migration:start';
const legacyEndMarker = '-- legacy-job-title-migration:end';

async function htmlFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await htmlFiles(new URL(`${entry.name}/`, directory), relative));
    } else if (entry.name.endsWith('.html')) {
      files.push({ path: relative, url: new URL(entry.name, directory) });
    }
  }
  return files;
}

function withoutLegacyBlock(source) {
  const start = source.indexOf(legacyStartMarker);
  const end = source.indexOf(legacyEndMarker);
  if (start < 0 || end <= start) throw new Error('DHO migration legacy block markers are missing or invalid');
  return `${source.slice(0, start)}${source.slice(end + legacyEndMarker.length)}`;
}

async function checkDhoNaming() {
  const migration = await readFile(migrationUrl, 'utf8');
  if (forbiddenLegacyName.test(withoutLegacyBlock(migration))) throw new Error('DHO migration contains the legacy RH name outside its legacy block');

  for (const file of (await readdir(migrationsRoot)).filter((name) => migrationFilename.test(name) && Number.parseInt(name, 10) > 30)) {
    const source = await readFile(new URL(file, migrationsRoot), 'utf8');
    if (forbiddenLegacyName.test(source)) throw new Error(`Future migration contains the legacy RH name: ${file}`);
  }

  for (const file of await htmlFiles(publicRoot)) {
    const source = await readFile(file.url, 'utf8');
    if (forbiddenLegacyName.test(source)) throw new Error(`Generated public file contains the legacy RH name: ${file.path}`);
  }
  console.log('dho naming: ok');
}

await checkDhoNaming();
