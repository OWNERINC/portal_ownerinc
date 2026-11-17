import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { load, response, routes } from '../helpers/readiness-harness.mjs';

const modes = ['success', 'write-rejected', 'rollback-lost', 'commit-rejected', 'commit-ack-lost', 'response-failed'];
for (const module of ['upload', 'autocard', 'pos-cards']) {
  for (const mode of modes) {
    test(`${module}: ${mode} keeps potentially referenced bytes and releases once`, async () => {
      const files = new Map();
      const oldKey = 'previous-photo.webp';
      if (module === 'upload') files.set(oldKey, Buffer.from('old image'));
      const state = { staged: null, committed: null, rollbacks: 0, releases: [], commits: 0, audits: 0 };
      const disk = {
        async mkdir() {},
        async writeFile(filename, bytes) { files.set(path.basename(filename), Buffer.from(bytes)); },
        async unlink(filename) { files.delete(path.basename(filename)); },
      };
      const client = {
        async query(sql, params = []) {
          const text = sql.replace(/\s+/g, ' ').trim();
          if (text === 'BEGIN') return { rows: [], rowCount: 0 };
          if (text.startsWith('SELECT photo_url')) return { rows: [{ photo_url: `/uploads/${oldKey}` }], rowCount: 1 };
          if (/^(UPDATE users SET photo_url|INSERT INTO (autocard_media|pos_card_media))/.test(text)) {
            if (mode === 'write-rejected') throw new Error('Synthetic write rejected');
            state.staged = { key: path.basename(params[1]), reference: module === 'upload' ? params[1] : params[0] };
            if (mode === 'rollback-lost') throw new Error('Synthetic write ACK lost');
            return { rows: [{ id: params[0], url: `/synthetic/${params[0]}` }], rowCount: 1 };
          }
          if (text.startsWith('INSERT INTO audit_log')) {
            state.audits++;
            return { rows: [], rowCount: 1 };
          }
          if (text === 'COMMIT') {
            state.commits++;
            if (mode === 'commit-rejected') { state.staged = null; throw new Error('Synthetic COMMIT rejected'); }
            state.committed = state.staged;
            state.staged = null;
            if (mode === 'commit-ack-lost') throw new Error('Synthetic COMMIT persisted then ACK lost');
            return { rows: [], rowCount: 0 };
          }
          if (text === 'ROLLBACK') {
            state.rollbacks++;
            if (mode === 'rollback-lost') throw new Error('Synthetic ROLLBACK unavailable');
            state.staged = null;
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`Unexpected SQL: ${text}`);
        },
        release(discard) { state.releases.push(Boolean(discard)); },
      };
      const registered = routes();
      const multer = () => ({ single: () => () => {} });
      multer.memoryStorage = () => ({});
      load(`api/routes/${module}.js`, {
        express: { Router: () => registered.router }, multer, 'node:fs/promises': disk,
        '../db': { connect: async () => client },
        '../middleware/auth': { authMiddleware() {} },
        '../middleware/validation': { normalizeImage: async () => Buffer.from('normalized synthetic image') },
      });
      const req = Object.assign(new EventEmitter(), {
        id: `${module}-${mode}`, user: { uid: 'synthetic-user' },
        headers: { 'content-type': 'image/png' }, file: { buffer: Buffer.from('input') },
      });
      const res = response();
      if (mode === 'response-failed') res.json = () => { throw new Error('Synthetic response failure'); };
      let error;
      const work = registered.find('post', module === 'upload' ? '/photo' : '/media')(req, res, caught => { error = caught; });
      if (module !== 'upload') { req.emit('data', Buffer.from('input')); req.emit('end'); }
      await work;

      const ambiguous = ['commit-rejected', 'commit-ack-lost', 'rollback-lost'].includes(mode);
      // This assertion fails on the old handlers even when SQL persisted.
      if (state.committed) assert.equal(files.has(state.committed.key), true, 'persisted reference must have bytes');
      assert.equal(files.size, mode === 'write-rejected'
        ? (module === 'upload' ? 1 : 0)
        : (module === 'upload' && ambiguous ? 2 : 1));
      assert.deepEqual(state.releases, [ambiguous]);
      assert.equal(state.rollbacks, ['write-rejected', 'rollback-lost'].includes(mode) ? 1 : 0);
      if (module === 'upload') assert.equal(files.has(oldKey), ambiguous || mode === 'write-rejected');
      if (mode === 'success') {
        assert.equal(error, undefined);
        assert.ok(res.body);
        assert.equal(res.statusCode, module === 'upload' ? 200 : 201);
      } else {
        assert.ok(error instanceof Error);
        assert.equal(res.body, undefined);
        assert.equal(error.commitAmbiguous === true, mode.startsWith('commit-'));
        assert.equal(error.rollbackAmbiguous === true, mode === 'rollback-lost');
      }
      if (module !== 'upload' && !['write-rejected', 'rollback-lost'].includes(mode)) assert.equal(state.audits, 1);
    });
  }
}

test('withAudit preserves undefined/null successful results without auditing and flags ambiguous empty commits', async () => {
  const { withAudit } = load('api/route-utils.js');
  for (const result of [undefined, null]) {
    for (const lost of [false, true]) {
      const queries = [], releases = [];
      const pool = { connect: async () => ({
        async query(sql) { queries.push(sql); if (lost && sql === 'COMMIT') throw new Error('ACK lost'); },
        release(discard) { releases.push(Boolean(discard)); },
      }) };
      const run = withAudit(pool, { user: { uid: 'uid' } }, 'test', 'test', async () => result);
      if (lost) await assert.rejects(run, error => error.commitAmbiguous === true);
      else assert.equal(await run, result);
      assert.deepEqual(queries, ['BEGIN', 'COMMIT']);
      assert.deepEqual(releases, [lost]);
    }
  }
});
