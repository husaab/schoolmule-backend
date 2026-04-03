const { execSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');

module.exports = async function globalSetup() {
  // In CI (GitHub Actions), PostgreSQL is provided as a service — skip Docker
  if (!process.env.CI) {
    console.log('\n[Integration] Starting test PostgreSQL container...');
    try {
      execSync('docker compose -f docker-compose.test.yml up -d --wait', {
        cwd: path.resolve(__dirname, '../../..'),
        stdio: 'pipe',
        timeout: 60000,
      });
      console.log('[Integration] PostgreSQL container ready');
    } catch (err) {
      console.error('[Integration] Failed to start Docker container:', err.message);
      throw err;
    }
  }

  // Set env vars for test database
  const pgConfig = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5433', 10),
    user: process.env.PG_USER || 'test_user',
    password: process.env.PG_PASSWORD || 'test_password',
    database: process.env.PG_DATABASE || 'schoolmule_test',
  };

  // Make these available to test workers
  process.env.PG_HOST = pgConfig.host;
  process.env.PG_PORT = String(pgConfig.port);
  process.env.PG_USER = pgConfig.user;
  process.env.PG_PASSWORD = pgConfig.password;
  process.env.PG_DATABASE = pgConfig.database;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests';
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test_resend_key';
  process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
  process.env.CROSS_ORIGIN_URL = process.env.CROSS_ORIGIN_URL || 'http://localhost:3000';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-service-role-key';
  process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'test@test.com';
  process.env.MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'test.com';
  process.env.ALHAADIACADEMY_RESEND_API_KEY = process.env.ALHAADIACADEMY_RESEND_API_KEY || 'test_key';

  // Connect and create schema
  let pool = new Pool({ ...pgConfig, ssl: false });

  try {
    // Wait for PostgreSQL to accept connections
    let retries = 10;
    while (retries > 0) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch (e) {
        retries--;
        if (retries === 0) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Terminate stale connections from previous test runs
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid != pg_backend_pid()
    `);
    await pool.end();
    await new Promise(r => setTimeout(r, 200));

    // Fresh pool with clean connections
    pool = new Pool({ ...pgConfig, ssl: false });

    // Drop all existing tables/types so seed.sql always creates fresh schema
    console.log('[Integration] Dropping existing schema...');
    await pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO test_user;
    `);

    console.log('[Integration] Running seed.sql...');
    const seedSql = fs.readFileSync(
      path.resolve(__dirname, 'seed.sql'),
      'utf-8'
    );
    await pool.query(seedSql);
    console.log('[Integration] Schema created successfully');
  } finally {
    await pool.end();
  }
};
