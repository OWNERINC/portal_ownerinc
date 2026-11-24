import assert from 'node:assert/strict';
import test from 'node:test';
import { load, response, routes } from '../helpers/readiness-harness.mjs';

function limiters() {
  const auth = routes();
  load('api/routes/auth.js', {
    express: { Router: () => auth.router }, '../db': {},
    '../middleware/auth': { firebaseAuth: {} },
    '../integrations/password-reset-email': {},
    '../services/pending-registration': {},
    '../services/user-invitation': {},
  });
  return path => auth.handlers('post', path)[0];
}

function hit(limiter, ip = '192.0.2.1') {
  const res = response();
  let allowed = false;
  limiter({ ip, id: 'registration-traffic' }, res, () => { allowed = true; });
  return { res, allowed };
}

test('registration permits 300 shared-IP attempts while both password routes retain 5/hour', () => {
  const limiter = limiters();
  for (const path of ['/register', '/password-reset', '/registration-password']) {
    const max = path === '/register' ? 300 : 5;
    for (let i = 0; i < max; i++) assert.equal(hit(limiter(path)).allowed, true);
    const denied = hit(limiter(path));
    assert.equal(denied.res.statusCode, 429);
    assert.ok(Number(denied.res.headers['Retry-After']) > 0);
    assert.ok(Number(denied.res.headers['Retry-After']) <= 3600);
    assert.equal(hit(limiter(path), '192.0.2.2').allowed, true);
  }
});

for (const value of ['0', '-1', 'invalid', '1.5', '9007199254740992']) {
  test(`invalid IP registration budget ${value} falls back to 300 attempts`, t => {
    const original = process.env.REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR;
    process.env.REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR = value;
    t.after(() => {
      if (original === undefined) delete process.env.REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR;
      else process.env.REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR = original;
    });
    const limiter = limiters()('/register');
    for (let i = 0; i < 300; i++) assert.equal(hit(limiter).allowed, true);
    assert.equal(hit(limiter).res.statusCode, 429);
  });
}

test('registration IP budget resets only when its one-hour window expires', t => {
  const original = Date.now;
  let now = 1000000;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  const limiter = limiters()('/register');
  for (let i = 0; i < 300; i++) assert.equal(hit(limiter).allowed, true);
  assert.equal(hit(limiter).res.headers['Retry-After'], '3600');
  now += 3599000;
  assert.equal(hit(limiter).res.headers['Retry-After'], '1');
  now += 1000;
  assert.equal(hit(limiter).allowed, true);
});
