// Guided tours: per-person progress and the event log (user_tours_migration.sql).
const COLS = 'tour_id, version, status, step_index, step_id, snoozed_until, completed_at, updated_at';

const tourQueries = {
  selectProgress: `
    SELECT ${COLS}
    FROM user_tour_progress
    WHERE user_id = $1
    ORDER BY tour_id
  `,

  selectCreatedAt: `
    SELECT created_at FROM users WHERE user_id = $1
  `,

  // A first event makes the row exist, so the lock below always has a row to
  // hold: two devices' first events then queue instead of both reading nothing.
  ensureProgress: `
    INSERT INTO user_tour_progress (user_id, tour_id, version, status)
    VALUES ($1, $2, $3, 'offered')
    ON CONFLICT (user_id, tour_id) DO NOTHING
  `,

  // Inside the event's transaction, so two devices can't race the same row.
  selectProgressForUpdate: `
    SELECT ${COLS}
    FROM user_tour_progress
    WHERE user_id = $1 AND tour_id = $2
    FOR UPDATE
  `,

  insertEvent: `
    INSERT INTO user_tour_events (user_id, tour_id, version, event, step_id, step_index, role, platform)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,

  updateProgress: `
    UPDATE user_tour_progress SET
      version = $3,
      status = $4,
      step_index = $5,
      step_id = $6,
      snoozed_until = $7,
      completed_at = $8,
      updated_at = NOW()
    WHERE user_id = $1 AND tour_id = $2
    RETURNING ${COLS}
  `,
};

module.exports = tourQueries;
