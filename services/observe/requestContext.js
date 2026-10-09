const { AsyncLocalStorage } = require('async_hooks');

// Carries { requestId, userId, school, role, req } through every await in
// a request so a controller's logger.error line can be tied back to it.
const als = new AsyncLocalStorage();

module.exports = {
  run: (ctx, fn) => als.run(ctx, fn),
  get: () => als.getStore() || null,
};
