module.exports = {
  displayName: 'integration',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/__tests__/integration/**/*.test.js'],
  globalSetup: '<rootDir>/__tests__/integration/setup/globalSetup.js',
  globalTeardown: '<rootDir>/__tests__/integration/setup/globalTeardown.js',
  setupFilesAfterEnv: ['<rootDir>/__tests__/integration/setup/setupTestDB.js'],
  moduleNameMapper: {
    '^(.*)/config/supabaseClient$': '<rootDir>/__tests__/__mocks__/config/supabaseClient.js',
    '^(.*)/config/database$': '<rootDir>/__tests__/integration/setup/testDatabase.js',
  },
  silent: true,
  forceExit: true,
  testTimeout: 30000,
  coverageDirectory: '<rootDir>/coverage/integration',
  collectCoverageFrom: [
    'controllers/**/*.js',
    'routes/**/*.js',
    'queries/**/*.js',
    '!**/node_modules/**',
  ],
};
