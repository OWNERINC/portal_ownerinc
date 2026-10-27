#!/usr/bin/env node
require('dotenv').config();
const pool = require('../db');
const { parseArguments, run } = require('../owner-news/cutover');

(async () => {
  try {
    const result = await run({ input: parseArguments(process.argv.slice(2)), pool });
    process.stdout.write(`${JSON.stringify({ service: 'owner-news-cutover', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: 'owner-news-cutover', status: 'refused', reason:
      typeof error?.code === 'string' ? error.code : 'cutover_failed' })}\n`);
    process.exitCode = 2;
  } finally { await pool.end().catch(() => {}); }
})();
