import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

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
    const globallyProtected = /router\.use\(authMiddleware,\s*require(?:AutoCard|PosCards)\)/.test(source);

    for (const route of routes) {
      if (file === 'auth.js' && route[1].includes("'/password-reset'")) {
        assert.match(route[1], /resetLimit/, 'password reset must remain rate limited');
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
