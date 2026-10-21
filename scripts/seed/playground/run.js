#!/usr/bin/env node
// scripts/seed/playground/run.js
//
// Runs sql/00_reset.sql … sql/07_extras.sql in order against the database in
// PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE (the backend's .env). Each
// file is one transaction; a failure stops the run and that file rolls back.
// Only PLAYGROUND's 2026-2027 year and the @playground.test accounts change.
//
//   node scripts/seed/playground/run.js --env ../schoolmule-backend/.env --confirm
//   node scripts/seed/playground/run.js --env .env --confirm --only 00,01

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};
require('dotenv').config({ path: flag('--env') || path.join(process.cwd(), '.env') });
const { Client } = require('pg');

if (!args.includes('--confirm')) {
  console.error(`This rewrites PLAYGROUND's 2026-2027 year in ${process.env.PG_HOST}/${process.env.PG_DATABASE}. Re-run with --confirm.`);
  process.exit(2);
}

(async () => {
  const dir = path.join(__dirname, 'sql');
  const only = typeof flag('--only') === 'string' ? flag('--only').split(',') : null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && (!only || only.some((p) => f.startsWith(p)))).sort();
  const client = new Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: process.env.PG_SSL_DISABLE === 'true' ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await client.connect();
  try {
    for (const f of files) {
      const started = Date.now();
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`FAIL ${f}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
        process.exitCode = 1;
        return;
      }
      console.log(`ok   ${f} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  } finally {
    await client.end();
  }
})();
