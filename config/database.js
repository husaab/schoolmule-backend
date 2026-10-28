// database.js
const { Pool } = require('pg');
const logger = require('../logger'); 
require('dotenv').config();

const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  port: process.env.PG_PORT,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  // Supabase requires SSL; set PG_SSL_DISABLE=true for local Postgres (e.g. the docker test db)
  ssl: process.env.PG_SSL_DISABLE === 'true' ? false : { rejectUnauthorized: false },
  // Pool size per process. Every process connected at once must fit in the
  // Supabase pooler's pool_size (session mode, port 5432), or it refuses
  // connections with EMAXCONNSESSION. A deploy runs the old and new server
  // side by side for a few seconds, and a local backend pointed at production
  // is a third process. Pooler 40, Railway PG_POOL_MAX=12 (2026-10-28):
  // two servers plus a local one fit.
  max: Number(process.env.PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  // Queue a burst locally instead of failing the request after 2s.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
});

const db = pool;

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
  process.exit(-1);
});

const testConnection = async () => {
  try {
    const res = await db.query('SELECT NOW()');
    logger.info({ connectedAt: res.rows[0].now }, 'PostgreSQL connected');
  } catch (err) {
    logger.error({ err }, 'PostgreSQL connection failed');
    process.exit(1);
  }
};

testConnection();

module.exports = db;
