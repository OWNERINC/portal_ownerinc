import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const pinnedImage = 'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752';

test('Pages upload location quotes its entire unchanged quantified regex for the Nginx parser', async () => {
  const config = await read('nginx/nginx.conf');
  const locations = [...config.matchAll(/^\s*location ~ "([^"]*\{36\}[^"]*)" \{/gm)];
  assert.equal(locations.length, 1, 'the quantified Pages location must be one fully quoted token');
  assert.equal(locations[0][1], '^/api/pages/[0-9a-fA-F-]{36}/media/?$');
});

test('CI blocks validation, image publication and deployment on real isolated pinned-image nginx -t', async () => {
  const [workflow, compose] = await Promise.all([read('.github/workflows/ci.yml'), read('docker-compose.yml')]);
  const image = compose.match(/^  nginx:\n\s+image: (\S+)/m)?.[1];
  assert.equal(image, pinnedImage, 'the syntax gate must test the production Compose image');
  const name = 'Validate Nginx configuration with pinned production image';
  const steps = [...workflow.matchAll(new RegExp(`^      - name: ${name}\\n([\\s\\S]*?)(?=^      - |^  deploy-production:)`, 'gm'))];
  assert.equal(steps.length, 1, 'one unconditional Nginx syntax gate must exist in the validate job');
  const step = steps[0];
  assert.doesNotMatch(step[1], /^\s*(?:if|continue-on-error):/m);
  const command = step[1].match(/^        run: \|\n([\s\S]*)/)?.[1].replace(/[ \t]*\\\n[ \t]*/g, ' ').trim();
  assert.equal(command, `docker run --rm --network none --read-only --tmpfs /var/cache/nginx --tmpfs /var/run --entrypoint nginx --mount type=bind,src="\${PWD}/nginx/nginx.conf",dst=/etc/nginx/conf.d/default.conf,readonly ${pinnedImage} -t`);
  assert.ok(step.index > workflow.indexOf('  validate:'));
  for (const gate of ['      - run: npm run verify', '      - name: Build production images', '      - name: Publish immutable images', '  deploy-production:']) {
    assert.ok(step.index < workflow.indexOf(gate), `Nginx syntax must pass before ${gate.trim()}`);
  }
  assert.match(workflow, /deploy-production:\n    name: Deploy production\n    needs: validate\n/);
});
