// Lazy-loads the Express app for supertest
// Safe because moduleNameMapper intercepts database/supabase requires
const request = require('supertest');
const { mockAdminUser } = require('./mockAuth');

let app;

function getApp() {
  if (!app) {
    app = require('../../server');
  }
  return app;
}

/** Create an authenticated supertest request with a real JWT Bearer token */
function authenticatedRequest(method, url, token) {
  const t = token || mockAdminUser();
  return request(getApp())[method](url)
    .set('Authorization', `Bearer ${t}`);
}

module.exports = { getApp, authenticatedRequest };
