const express = require('express');
const db = require('../config/database');
const buffer = require('../services/observe/eventBuffer');

const router = express.Router();
const startedAt = Date.now();

// Public liveness + a cheap db probe, for Railway and the Observe console.
router.get('/', async (_req, res) => {
  let dbState = 'ok';
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 1000)),
    ]);
  } catch {
    dbState = 'down';
  }
  const ok = dbState === 'ok';
  res.status(ok ? 200 : 503).json({
    ok,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    db: dbState,
    buffer: buffer.stats(),
  });
});

module.exports = router;
