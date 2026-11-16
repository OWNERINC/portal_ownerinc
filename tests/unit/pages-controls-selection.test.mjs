import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const select = async (argv, env) => {
  const { selectControlsCase } = await import('../helpers/pages-controls-case.mjs');
  return selectControlsCase(argv, env);
};
test('controls selection: env-only, positional-only, positional precedence, default', async () => {
  assert.equal(await select([], { PAGES_CONTROLS_CASE: 'save' }), 'save');
  assert.equal(await select(['inspector'], {}), 'inspector');
  assert.equal(await select(['review'], { PAGES_CONTROLS_CASE: 'save' }), 'review');
  assert.equal(await select(['menus'], { PAGES_CONTROLS_CASE: 'invalid' }), 'menus');
  assert.equal(await select([], {}), 'menus');
});
test('controls selection rejects invalid and empty explicit values', async () => {
  for (const value of ['unknown', '', 'SAVE']) {
    await assert.rejects(select([value], {}), /Invalid Pages controls case/);
    await assert.rejects(select([], { PAGES_CONTROLS_CASE: value }), /Invalid Pages controls case/);
  }
});
test('invalid CLI selection fails before output, external imports or harness setup', () => {
  for (const args of [['unknown'], []]) {
    const result = spawnSync(process.execPath, ['tests/visual/check-pages-controls.mjs', ...args], {
      encoding: 'utf8', env: { ...process.env, PAGES_CONTROLS_CASE: 'unknown', PGLITE_MODULE_PATH: '', PLAYWRIGHT_MODULE_PATH: '', PAGES_CONTROLS_OUTPUT: '' }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid Pages controls case/);
    assert.doesNotMatch(result.stderr, /Set a new evidence directory|Cannot find package|ERR_MODULE_NOT_FOUND/);
  }
});
