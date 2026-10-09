const crypto = require('crypto');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Collapses the parts of a message that vary per occurrence so one bug
// groups under one fingerprint: ids, numbers, quoted values.
function normalizeMessage(message) {
  return String(message || '')
    .replace(UUID_RE, '<id>')
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/'[^']*'/g, "'<str>'")
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function fingerprint(route, message) {
  return crypto
    .createHash('sha1')
    .update(`${route || ''}|${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 16);
}

module.exports = { fingerprint, normalizeMessage };
