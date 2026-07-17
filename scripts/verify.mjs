#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return result.stdout;
}

async function filesUnder(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : filesUnder(target, extension);
    }
    return target.endsWith(extension) ? [target] : [];
  }));
  return files.flat();
}

async function checkSyntax() {
  console.log('verify: syntax');
  const serverFiles = (await Promise.all(
    ['api', 'cron'].map((directory) => filesUnder(directory, '.js'))
  )).flat();
  for (const file of serverFiles) run(process.execPath, ['--check', file]);

  for (const file of await filesUnder('public', '.js')) {
    run(process.execPath, ['--input-type=module', '--check'], {
      input: await readFile(file, 'utf8')
    });
  }

  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status === 0) run('bash', ['-n', 'deploy.sh']);
}

async function checkTests() {
  console.log('verify: tests');
  const tests = await filesUnder('tests', '.test.mjs');
  run(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
}

async function checkSecrets() {
  console.log('verify: security');
  run('git', ['check-ignore', '-q', '.env']);
  const output = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const excluded = new Set(['.env.example', 'public/js/firebase-config.js']);
  const textExtensions = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.sql', '.yml', '.yaml', '.toml', '.sh']);
  const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|SENDGRID_API_KEY=SG\.[A-Za-z0-9_-]{10,}|POSTGRES_PASSWORD=\S{12,}/;

  for (const file of output.split('\0').filter(Boolean)) {
    if (excluded.has(file) || !textExtensions.has(path.extname(file))) continue;
    if (secret.test(await readFile(file, 'utf8'))) {
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
  run('docker', ['compose', 'config', '--quiet'], {
    env: { ...process.env, ENV_FILE: '.env.example' }
  });
}

const mode = process.argv[2] || 'all';
if (mode === 'all' || mode === 'syntax') await checkSyntax();
if (mode === 'all' || mode === 'tests') await checkTests();
if (mode === 'all' || mode === 'security') await checkSecrets();
if (mode === 'all') checkCompose();
console.log('verify: ok');
