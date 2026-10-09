// All of a console request's queries run on one connection inside a
// transaction with a statement timeout, so a heavy window can neither hog
// the 10-connection pool nor run forever.
const db = require('../../config/database');

async function withTimedClient(fn, timeoutMs = 8000) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Number(timeoutMs) | 0)}`);
    const q = (text, params) => client.query(text, params);
    const result = await fn(q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTimedClient };
