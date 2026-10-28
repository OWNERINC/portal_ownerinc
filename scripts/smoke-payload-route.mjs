#!/usr/bin/env node
/** Gate D local smoke. It never starts Docker, opens a browser, or promotes a route. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.argv.length !== 3 || process.argv[2] !== '--static') {
  console.error('Usage: node scripts/smoke-payload-route.mjs --static');
  process.exit(2);
}

const [base, inactive, baseline, active, baselineReceipt, promoted, unavailable, overlay, controller] = await Promise.all([
  'nginx/nginx.conf', 'nginx/editorial-route.inactive.conf',
  'nginx/editorial-route-state/baseline-inactive/include.conf', 'nginx/editorial-route-state/active.conf',
  'nginx/editorial-route-state/baseline-inactive/manifest.json', 'nginx/editorial-route.promoted.conf',
  'nginx/editorial-route.unavailable.conf',
  'ops/compose.payload.route-promoted.yaml',
  'ops/payload-route-promotion.py',
].map(file => readFile(file, 'utf8')));

assert.match(base, /include \/etc\/nginx\/editorial-route-state\/active\.conf;/u);
assert.doesNotMatch(base, /return 308 \/editorial\/admin/u);
assert.equal(baseline, inactive);
assert.equal(active, 'include /etc/nginx/editorial-route-state/baseline-inactive/include.conf;\n');
assert.equal(JSON.parse(baselineReceipt).status, 'inactive-template');
assert.equal(JSON.parse(baselineReceipt).routeConfigSha256, createHash('sha256').update(baseline).digest('hex'));
assert.match(inactive, /location = \/editorial \{ return 404; \}/u);
assert.doesNotMatch(inactive, /proxy_pass/u);
assert.match(promoted, /return 308 \/editorial\/admin/u);
assert.match(promoted, /proxy_pass \$cms_upstream/u);
assert.match(promoted, /location = \/editorial\/ready \{ return 404; \}/u);
assert.match(promoted, /error_page 502 503 504 = @editorial_unavailable/u);
assert.match(unavailable, /return 503/u);
assert.doesNotMatch(unavailable, /proxy_pass/u);
assert.match(overlay, /\/var\/lib\/ownerinc\/payload-route:\/etc\/nginx\/editorial-route-state:ro/u);
assert.doesNotMatch(overlay, /payload-route\/[^:]+:\/etc\/nginx/u);
assert.match(overlay, /test -s \/etc\/nginx\/editorial-route-state\/active\.conf && nginx -t && exec nginx/u);
for (const requirement of ['STATE.read_state(runtime_dir)', "intent.get('stage') != 'floor_committed'",
  "fail('release_container_divergence')", "fail('private_readiness_failed')", 'PUBLICATION_BOUNDARIES',
  'fcntl.LOCK_EX | fcntl.LOCK_NB', "os.path.join(root, 'active.conf')", 'initialize_route_state',
  "result.get('durability') != 'committed'"]) assert.ok(controller.includes(requirement));

console.log(JSON.stringify({
  gate: 'D', status: 'implemented', mode: 'static', routePromoted: false,
  promotedConfigSha256: createHash('sha256').update(promoted).digest('hex'),
  pendingEvidence: ['disposable_https', 'browser', 'linux_docker'],
}));
