import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('database is not exposed by Docker Compose', async () => {
  const compose = await readFile('docker-compose.yml', 'utf8');
  const postgres = compose.match(/  postgres:\n([\s\S]*?)(?=\n  api:)/)?.[1];

  assert.ok(postgres, 'postgres service must exist');
  assert.doesNotMatch(postgres, /^    ports:/m);
});

test('every API resource route requires authentication', async () => {
  const files = await readdir('api/routes');

  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(`api/routes/${file}`, 'utf8');
    const routes = source.matchAll(/router\.(?:get|post|put|delete)\(([^\n]+)/g);
    const globalProtection = source.match(/router\.use\(authMiddleware,\s*require(?:AutoCard|PosCards)\)/);

    for (const route of routes) {
      const globallyProtected = globalProtection?.index < route.index;
      if (file === 'auth.js' && (route[1].includes("'/password-reset'")
        || route[1].includes("'/register'") || route[1].includes("'/registration-password'"))) {
        assert.match(route[1], /(?:resetLimit|registrationLimit|registrationPasswordLimit)/, 'public auth route must remain rate limited');
        continue;
      }
      if (file === 'editorial-internal.js') {
        assert.ok(source.indexOf('assertEditorialService(req, env)') < route.index, 'private editorial routes require service authentication first');
        assert.match(source, /router\.use\(express\.json\(\{ limit: '16kb' \}\)\)/);
        continue;
      }
      if (file === 'editorial-session.js') {
        assert.ok(source.indexOf('assertEditorialOrigin(req, req.editorialCookie)') < route.index, 'editorial mutations require the origin guard');
        assert.match(source, /router\.post\('\/', authenticate,/);
        assert.match(source, /createAuthMiddleware\(\{ db, firebaseAuth, onTokenError: firebaseError \}\)/);
        assert.match(source, /router\.get\('\/',[\s\S]*await resolveEditorialSession\(\{ firebaseAuth, db, cookie \}\)/);
        assert.match(source, /router\.delete\('\/',[\s\S]*await revokeEditorialSession/);
        continue;
      }
      if (!globallyProtected) assert.match(route[1], /authMiddleware/, `${file}: unauthenticated route`);
    }
  }
});

test('uploads and the separate agent remain outside version control', async () => {
  const ignore = await readFile('.gitignore', 'utf8');

  assert.match(ignore, /^uploads\/$/m);
  assert.match(ignore, /^ownerinc-novo-agente\/$/m);
});

test('review snapshots remain local and outside the active repository surface', async () => {
  const ignore = await readFile('.gitignore', 'utf8');
  assert.match(ignore, /^\.openchamber\/reviews\/\*\.diff$/m);
  assert.match(ignore, /^\.openchamber\/reviews\/\*-inputs-\*\.json$/m);

  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--', '.openchamber/reviews'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  const trackedReviewSnapshots = stdout.split('\0').filter(Boolean).filter((file) =>
    file.endsWith('.diff') || /-inputs-[^/]+\.json$/.test(file));
  assert.deepEqual(trackedReviewSnapshots, [], 'review snapshots must not be tracked by Git');
});
