// Convenience functions for setting up db mock responses
const db = require('../__mocks__/config/database');

/** Mock a successful db.query response */
function mockQueryResponse(rows, rowCount) {
  db.query.mockResolvedValueOnce({
    rows: rows || [],
    rowCount: rowCount !== undefined ? rowCount : (rows || []).length,
  });
}

/** Mock a db.query rejection */
function mockQueryError(error) {
  db.query.mockRejectedValueOnce(error instanceof Error ? error : new Error(error));
}

/** Mock a PostgreSQL-specific error with code (23505=unique, 23503=fk) */
function mockPgError(code, message) {
  const err = new Error(message || `PG error ${code}`);
  err.code = code;
  db.query.mockRejectedValueOnce(err);
}

/**
 * Mock a transaction sequence: BEGIN, ...queries, COMMIT
 * @param {Array} responses - Array of { rows, rowCount } for each query between BEGIN and COMMIT
 */
function mockTransactionSequence(responses) {
  const client = db._mockClient;
  // BEGIN
  client.query.mockResolvedValueOnce({});
  // User queries
  for (const resp of responses) {
    client.query.mockResolvedValueOnce({
      rows: resp.rows || [],
      rowCount: resp.rowCount !== undefined ? resp.rowCount : (resp.rows || []).length,
    });
  }
  // COMMIT
  client.query.mockResolvedValueOnce({});
}

/**
 * Mock a transaction that fails at a specific query index
 * @param {number} failAtIndex - 0-based index of the query that fails (after BEGIN)
 * @param {Error|string} error - The error to throw
 * @param {Array} successResponses - Responses for queries before the failure
 */
function mockTransactionError(failAtIndex, error, successResponses = []) {
  const client = db._mockClient;
  // BEGIN
  client.query.mockResolvedValueOnce({});
  // Successful queries before failure
  for (let i = 0; i < failAtIndex; i++) {
    const resp = successResponses[i] || { rows: [] };
    client.query.mockResolvedValueOnce({
      rows: resp.rows || [],
      rowCount: resp.rowCount !== undefined ? resp.rowCount : (resp.rows || []).length,
    });
  }
  // Failing query
  const err = error instanceof Error ? error : new Error(error);
  client.query.mockRejectedValueOnce(err);
  // ROLLBACK (called in catch)
  client.query.mockResolvedValueOnce({});
}

module.exports = {
  mockQueryResponse,
  mockQueryError,
  mockPgError,
  mockTransactionSequence,
  mockTransactionError,
};
