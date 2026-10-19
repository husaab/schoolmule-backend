// utils/transaction.js
const db = require('../config/database');

/**
 * Runs fn(client) in a transaction on one pooled connection and resolves to
 * its result. Any throw rolls back and is rethrown; the connection is always
 * released.
 */
async function inTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { inTransaction };
