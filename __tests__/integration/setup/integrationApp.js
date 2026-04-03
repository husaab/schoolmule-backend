// Integration test app helper
// Uses REAL database (via Docker) but MOCK supabase storage
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app;

function getApp() {
  if (!app) {
    // Set env vars before loading app
    process.env.PG_HOST = process.env.PG_HOST || 'localhost';
    process.env.PG_PORT = process.env.PG_PORT || '5433';
    process.env.PG_USER = process.env.PG_USER || 'test_user';
    process.env.PG_PASSWORD = process.env.PG_PASSWORD || 'test_password';
    process.env.PG_DATABASE = process.env.PG_DATABASE || 'schoolmule_test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests';
    process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test_resend_key';
    process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
    process.env.CROSS_ORIGIN_URL = process.env.CROSS_ORIGIN_URL || 'http://localhost:3000';
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-key';
    process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'test@test.com';
    process.env.MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'test.com';
    process.env.ALHAADIACADEMY_RESEND_API_KEY = process.env.ALHAADIACADEMY_RESEND_API_KEY || 'test_key';

    app = require('../../../server');
  }
  return app;
}

/** Create an authenticated supertest request with a real JWT */
function authenticatedRequest(method, url, tokenPayload = {}) {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests';
  const payload = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    username: 'Test Admin',
    email: 'admin@test.com',
    school: 'ALHAADIACADEMY',
    role: 'ADMIN',
    isVerified: true,
    isVerifiedSchool: true,
    activeTerm: 'Term 1 2025-2026',
    ...tokenPayload,
  };
  const token = jwt.sign(payload, secret, { expiresIn: '1h' });

  return request(getApp())[method](url)
    .set('Authorization', `Bearer ${token}`);
}

module.exports = { getApp, authenticatedRequest };
