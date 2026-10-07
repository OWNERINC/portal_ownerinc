#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options });
  if (result.status !== 0 || result.error || result.signal) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    const error = new Error(`${command} ${args.join(' ')} failed${result.signal ? ` (${result.signal})` : ''}`);
    error.exitCode = result.status || 1;
    throw error;
  }
  return result.stdout;
}

export async function filesUnder(directory, extensions) {
  if (!Array.isArray(extensions)) extensions = [extensions];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', '.next', '.git'].includes(entry.name) ? [] : filesUnder(target, extensions);
    }
    return entry.isFile() && extensions.some(extension => target.endsWith(extension)) ? [target] : [];
  }));
  return files.flat().sort();
}

async function checkSyntax() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error(`Node 24 is required; running ${process.version}`);
  }
  console.log('verify: syntax');
  const serverFiles = (await Promise.all(
    ['api', 'cron'].map((directory) => filesUnder(directory, '.js'))
  )).flat();
  for (const file of serverFiles) run(process.execPath, ['--check', file]);

  for (const file of await filesUnder('public', ['.js', '.mjs'])) {
    run(process.execPath, ['--input-type=module', '--check'], {
      input: await readFile(file, 'utf8')
    });
  }

  for (const file of await filesUnder('scripts', '.mjs')) run(process.execPath, ['--check', file]);

  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status === 0) {
    run('bash', ['-n', 'deploy.sh']);
    for (const directory of ['scripts', 'ops']) {
      for (const file of await filesUnder(directory, '.sh')) run('bash', ['-n', file]);
    }
  }
}

async function checkTests() {
  console.log('verify: tests');
  const tests = await filesUnder('tests/unit', '.test.mjs');
  run(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  console.log('verify: CMS unit tests (offline)');
  run(process.execPath, ['cms/scripts/test.mjs'], { stdio: 'inherit' });
}

function checkCmsTypes() {
  console.log('verify: CMS types (offline, no incremental cache write)');
  run(process.execPath, ['cms/node_modules/typescript/bin/tsc', '--project', 'cms/tsconfig.json', '--noEmit', '--incremental', 'false'], { stdio: 'inherit' });
}

export const secretTextExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.scss', '.json', '.html', '.css', '.md', '.sql', '.yml', '.yaml', '.toml', '.sh']);
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|SENDGRID_API_KEY=SG\.[A-Za-z0-9_-]{10,}|SMTP_PASSWORD=re_[A-Za-z0-9_-]{10,}|POSTGRES_PASSWORD=\S{12,}/;
export function containsPossibleSecret(file, contents) {
  return secretTextExtensions.has(path.extname(file)) && secret.test(contents);
}

async function checkSecrets() {
  console.log('verify: security');
  run('git', ['check-ignore', '-q', '.env']);
  const output = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const excluded = new Set(['.env.example', 'public/js/firebase-config.js']);

  for (const file of output.split('\0').filter(Boolean)) {
    if (excluded.has(file) || !secretTextExtensions.has(path.extname(file))) continue;
    const contents = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (containsPossibleSecret(file, contents)) {
      throw new Error(`possible secret found in ${file}`);
    }
  }
}

function checkCompose() {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    console.log('verify: Docker Compose unavailable, skipping compose validation');
    return;
  }
  console.log('verify: compose');
  run('docker', ['compose', '--env-file', '.env.example', 'config', '--quiet']);
}

function checkDhoNaming() {
  run(process.execPath, ['scripts/check-dho-naming.mjs']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(root);
  try {
    const mode = process.argv[2] || 'all';
    if (!['all', 'syntax', 'tests', 'types', 'security', 'dho'].includes(mode)) throw new Error('Unknown verify mode');
    if (mode === 'all' || mode === 'syntax') await checkSyntax();
    if (mode === 'all' || mode === 'types') checkCmsTypes();
    if (mode === 'all' || mode === 'tests') await checkTests();
    if (mode === 'all' || mode === 'security') await checkSecrets();
    if (mode === 'all' || mode === 'dho') checkDhoNaming();
    if (mode === 'all') checkCompose();
    console.log('verify: ok');
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
