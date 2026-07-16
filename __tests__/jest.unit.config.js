module.exports = {
  displayName: 'unit',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/__tests__/unit/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/helpers/unitSetup.js'],
  moduleNameMapper: {
    '^(.*)/config/database$': '<rootDir>/__tests__/__mocks__/config/database.js',
    '^(.*)/config/supabaseClient$': '<rootDir>/__tests__/__mocks__/config/supabaseClient.js',
  },
  silent: true,
  // Typed-array ops are ~50x slower in jest's sandbox realm; injecting the
  // host globals restores native speed for the schedule solver's bitsets.
  sandboxInjectedGlobals: ['Uint32Array', 'Int32Array', 'Uint8Array', 'Float64Array', 'Math', 'Date'],
  forceExit: true,
  maxWorkers: 1,
  coverageDirectory: '<rootDir>/coverage/unit',
  collectCoverageFrom: [
    'controllers/**/*.js',
    'middleware/**/*.js',
    'utils/**/*.js',
    'services/**/*.js',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
};
