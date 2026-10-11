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
  // Pool size per process. Must stay below the Supabase pooler's pool_size
  // (session mode, port 5432) divided by the number of Railway replicas, or
  // the pooler refuses connections with EMAXCONNSESSION. Pooler is set to 25;
  // one replica -> 20 here leaves headroom for the SQL editor and tooling.
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
