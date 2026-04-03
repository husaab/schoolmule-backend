const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-unit-tests';

const TEST_ADMIN_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEST_PARENT_USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const TEST_STAFF_USER_ID = '550e8400-e29b-41d4-a716-446655440003';

const TEST_SCHOOL = 'ALHAADIACADEMY';

// Generate a real JWT token that will pass jwt.verify()
function generateTestToken(overrides = {}) {
  const payload = {
    userId: TEST_ADMIN_USER_ID,
    username: 'Test Admin',
    email: 'admin@test.com',
    school: TEST_SCHOOL,
    role: 'ADMIN',
    isVerified: true,
    isVerifiedSchool: true,
    activeTerm: 'Term 1 2025-2026',
    ...overrides,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function mockAdminUser(overrides = {}) {
  return generateTestToken({
    userId: TEST_ADMIN_USER_ID,
    username: 'Admin User',
    email: 'admin@test.com',
    role: 'ADMIN',
    isVerified: true,
    isVerifiedSchool: true,
    ...overrides,
  });
}

function mockTeacherUser(overrides = {}) {
  return generateTestToken({
    userId: TEST_TEACHER_USER_ID,
    username: 'Teacher User',
    email: 'teacher@test.com',
    role: 'TEACHER',
    isVerified: true,
    isVerifiedSchool: true,
    ...overrides,
  });
}

function mockParentUser(overrides = {}) {
  return generateTestToken({
    userId: TEST_PARENT_USER_ID,
    username: 'Parent User',
    email: 'parent@test.com',
    role: 'PARENT',
    isVerified: true,
    isVerifiedSchool: true,
    ...overrides,
  });
}

function mockStaffUser(overrides = {}) {
  return generateTestToken({
    userId: TEST_STAFF_USER_ID,
    username: 'Staff User',
    email: 'staff@test.com',
    role: 'STAFF',
    isVerified: true,
    isVerifiedSchool: true,
    ...overrides,
  });
}

function mockUnverifiedUser(overrides = {}) {
  return generateTestToken({
    isVerified: false,
    isVerifiedSchool: false,
    ...overrides,
  });
}

function mockUnverifiedSchoolUser(overrides = {}) {
  return generateTestToken({
    isVerified: true,
    isVerifiedSchool: false,
    ...overrides,
  });
}

module.exports = {
  JWT_SECRET,
  TEST_ADMIN_USER_ID,
  TEST_TEACHER_USER_ID,
  TEST_PARENT_USER_ID,
  TEST_STAFF_USER_ID,
  TEST_SCHOOL,
  generateTestToken,
  mockAdminUser,
  mockTeacherUser,
  mockParentUser,
  mockStaffUser,
  mockUnverifiedUser,
  mockUnverifiedSchoolUser,
};
