// services/assistant/tools/index.js
// Loads every tool into the registry, once.
require('./staff/classes');
require('./staff/guide');
require('./staff/insights');
require('./staff/attendance');
require('./staff/assets');
require('./staff/comments');
require('./staff/writes');
require('./parent/family');

module.exports = require('./registry');
