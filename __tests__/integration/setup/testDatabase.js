// Integration test database module — replaces config/database.js
// Connects to Docker PostgreSQL without SSL, no process.exit on failure
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5433', 10),
  user: process.env.PG_USER || 'test_user',
  password: process.env.PG_PASSWORD || 'test_password',
  database: process.env.PG_DATABASE || 'schoolmule_test',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 10000,
});

// Silently handle 57P01 (admin_shutdown) errors — expected during test teardown
pool.on('error', (err) => {
  if (err.code === '57P01') return;
  console.error('Unexpected test pool error:', err);
});

module.exports = pool;
