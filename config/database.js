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
  ssl: {
    rejectUnauthorized: false, // Supabase requires SSL
  },
  max: 10, // optional: connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
