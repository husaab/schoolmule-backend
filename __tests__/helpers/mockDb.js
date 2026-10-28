// Convenience functions for setting up db mock responses
const db = require('../__mocks__/config/database');
const analyticsQueries = require('../../queries/analytics.queries');

/** Mock a successful db.query response */
function mockQueryResponse(rows, rowCount) {
  db.query.mockResolvedValueOnce({
    rows: rows || [],
    rowCount: rowCount !== undefined ? rowCount : (rows || []).length,
  });
}

// The narrow queries of one analytics matrix read
// (services/analyticsMatrix.loadMatrixRows), in the order it runs them.
const MATRIX_READS = {
  selectMatrixClasses: 'classes',
  selectMatrixAssessments: 'assessments',
  selectMatrixEnrollments: 'enrollments',
  selectMatrixStudents: 'students',
  selectMatrixScores: 'scores',
  selectMatrixLeftOutCells: 'leftOutCells',
};

/**
 * Split matrix rows in the shape the engine groups (one per class, student
 * and assessment) into what each narrow query returns. A row's is_excluded
 * without a status reads as an excused cell.
 */
function splitMatrixRows(rows = []) {
  const unique = (keyOf, cols) => {
    const seen = new Map();
    for (const r of rows) if (!seen.has(keyOf(r))) seen.set(keyOf(r), pick(r, cols));
    return [...seen.values()];
  };
  const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
  return {
    classes: unique((r) => r.class_id, ['class_id', 'class_grade', 'subject', 'teacher_name', 'show_class_average', 'term_id']),
    assessments: unique((r) => `${r.class_id}:${r.assessment_id}`, [
      'class_id', 'assessment_id', 'assessment_name', 'weight_percent', 'weight_points', 'max_score', 'is_parent',
      'parent_assessment_id', 'assessment_date', 'sort_order', 'is_published', 'parent_comment', 'published_at', 'is_turn_in',
    ]),
    enrollments: unique((r) => `${r.class_id}:${r.student_id}`, ['class_id', 'student_id', 'stats_left_out_class']),
    students: unique((r) => r.student_id, ['student_id', 'student_name', 'student_grade', 'homeroom_teacher_id']),
    scores: rows.map((r) => ({
      student_id: r.student_id,
      assessment_id: r.assessment_id,
      score: r.score ?? null,
      status: r.status ?? (r.is_excluded ? 'excused' : null),
    })),
    leftOutCells: rows.filter((r) => r.stats_left_out_assessment).map((r) => pick(r, ['class_id', 'student_id', 'assessment_id'])),
  };
}

/** Mock one analytics matrix read: its narrow queries' responses, in order. */
function mockMatrixRows(rows) {
  const parts = splitMatrixRows(rows || []);
  for (const part of Object.values(MATRIX_READS)) mockQueryResponse(parts[part]);
}

/**
 * For tests that answer db.query by SQL: which part of a matrix read `sql`
 * is ('classes', 'scores', …) and its scope ('term', 'students', …), or null
 * for any other query.
 */
function matrixReadOf(sql) {
  for (const [key, part] of Object.entries(MATRIX_READS)) {
    for (const [scope, text] of Object.entries(analyticsQueries[key])) {
      if (text === sql) return { part, scope };
    }
  }
  return null;
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
  mockMatrixRows,
  splitMatrixRows,
  matrixReadOf,
  mockQueryError,
  mockPgError,
  mockTransactionSequence,
  mockTransactionError,
};
