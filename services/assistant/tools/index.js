// services/assistant/tools/index.js
// Loads every tool into the registry, once.
require('./staff/classes');
require('./staff/guide');
require('./staff/insights');
require('./staff/writes');

module.exports = require('./registry');
