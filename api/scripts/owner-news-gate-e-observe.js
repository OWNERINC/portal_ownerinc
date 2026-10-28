#!/usr/bin/env node
require('dotenv').config();
const pool = require('../db');
const { parseObserverArguments, produceObservation } = require('../owner-news/gate-e-observer');

(async () => {
  try {
    const result = await produceObservation({ input: parseObserverArguments(process.argv.slice(2)), pool });
    process.stdout.write(`${JSON.stringify({ service: 'owner-news-gate-e-observe', status: 'observed', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: 'owner-news-gate-e-observe', status: 'refused',
      reason: typeof error?.code === 'string' ? error.code : 'observation_failed' })}\n`);
    process.exitCode = 2;
  } finally { await pool.end().catch(() => {}); }
})();
