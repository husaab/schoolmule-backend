// Set env vars BEFORE any controller modules load
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-unit-tests';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test_resend_key';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
process.env.CROSS_ORIGIN_URL = process.env.CROSS_ORIGIN_URL || 'http://localhost:3000';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-service-role-key';
process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'test@test.com';
process.env.MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'test.com';
process.env.ALHAADIACADEMY_RESEND_API_KEY = process.env.ALHAADIACADEMY_RESEND_API_KEY || 'test_resend_key_2';

// Global afterEach for unit tests - resets all mocks between tests
const db = require('../__mocks__/config/database');
const supabase = require('../__mocks__/config/supabaseClient');

afterEach(() => {
  db._reset();
  supabase._reset();
  jest.clearAllMocks();
});
