import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(new URL('../../api/routes/autocard.js', import.meta.url));
const require = createRequire(filename);
const express = require('express');
const supertest = require('supertest');
const { requestContext, errorHandler } = require('../middleware/security');
const actors = {
  allowed: { uid: 'autocard-contract-fixture', role: 'viewer', job_title_active: true, job_title_access: { autocard: true } },
  denied: { uid: 'autocard-denied-fixture', role: 'viewer', job_title_active: false, job_title_access: { autocard: true } },
};

// Complete, unmodified route: real parseCard/UUID/allowlists, policy, audit
// helper, Express and JSON parsing. Only identity and database results are
// doubles. No DB/Firebase modules, environment or media filesystem is opened.
export async function createAutoCardContractHarness(t) {
  const state = { sql: [], cards: new Map(), media: new Set(), connections: 0, releases: 0 };
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });
  const pool = {
    async query(sql, params = []) {
      state.sql.push({ sql, params: structuredClone(params) });
      if (/^(BEGIN|COMMIT|ROLLBACK)$|pg_advisory_xact_lock|INSERT INTO audit_log/.test(sql)) return result([]);
      if (/SELECT 1 FROM autocard_media/.test(sql)) return result(state.media.has(params[0]) ? [{ exists: 1 }] : []);
      // Project bound values, not SQL semantics. This store is not PostgreSQL,
      // and deliberately fails if the route starts using a different query.
      const creating = /INSERT INTO autocard_cards \(name, template/.test(sql);
      const updating = /UPDATE autocard_cards SET name = \$2/.test(sql);
      if (creating || updating) {
        const id = creating ? randomUUID() : params[0];
        if (updating && !state.cards.has(id)) return result([]);
        const [name, template, values, icon, illustration, mode, variant, mediaSize, mediaId, crop] = params.slice(creating ? 0 : 1);
        const card = { id, name, template, values: JSON.parse(values), icon, illustration, mode, variant, mediaSize, mediaId, mediaCrop: JSON.parse(crop) };
        state.cards.set(id, card);
        return result([card]);
      }
      if (/FROM autocard_cards WHERE id = \$1/.test(sql)) return result(state.cards.has(params[0]) ? [state.cards.get(params[0])] : []);
      throw new Error(`Unscripted AutoCard contract query: ${sql}`);
    },
    async connect() { state.connections++; return { query: pool.query, release() { state.releases++; } }; },
  };
  const unexpected = () => { throw new Error('Media filesystem access is outside this contract fixture'); };
  const dependencies = new Map([
    ['../db', pool],
    ['../middleware/auth', { authMiddleware(req, res, next) {
      const actor = actors[req.get('authorization')?.replace(/^Bearer /, '')];
      if (!actor) return res.status(401).json({ error: 'Fixture authentication required.', requestId: req.id });
      req.user = structuredClone(actor); next();
    } }],
    ['node:fs/promises', new Proxy({}, { get: () => unexpected })],
  ]);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', await readFile(filename, 'utf8'))(
    name => dependencies.has(name) ? dependencies.get(name) : require(name),
    module, module.exports, { env: {} },
  );
  const app = express();
  app.use(requestContext, express.json());
  app.use('/api/autocard', module.exports);
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const request = supertest(`http://127.0.0.1:${server.address().port}`);
  return {
    state,
    send({ path, options = {} }, actor = 'allowed') {
      const call = request[(options.method || 'GET').toLowerCase()](path);
      if (actor) call.set('Authorization', `Bearer ${actor}`);
      // Header composition has its separate real-auth regression. This fixture
      // forwards the caller's JSON bytes to the real route validator unchanged.
      return options.body === undefined ? call : call.set('Content-Type', 'application/json').send(options.body);
    },
  };
}
