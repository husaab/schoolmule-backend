// services/assistant/tools/index.js
// Loads every tool into the registry, once.
require('./staff/classes');
require('./staff/guide');

module.exports = require('./registry');
