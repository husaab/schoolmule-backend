// The email outbox in integration tests: a publish only queues its emails
// (services/email/outbox.js), so a test sends them the way the notifier's
// tick does once the hold is over.

const outbox = require('../../services/email/outbox');

/**
 * Sends every queued email now (the hold and any retry wait skipped).
 * @returns {Promise<number>} the rows handled
 */
async function deliverQueuedEmails(pool, { limit = 500 } = {}) {
  await pool.query(`UPDATE email_outbox SET send_after = NOW() WHERE status = 'pending'`);
  return outbox.drainOutbox({ limit, pauseMs: 0 });
}

/** The outbox rows, oldest first. */
async function outboxRows(pool) {
  return (await pool.query(
    `SELECT id, kind, recipient_email, student_id, class_id, subject_id, status, attempts, error_count,
            last_error, skip_reason, merged_into, payload, send_after, created_at
     FROM email_outbox ORDER BY created_at, recipient_email NULLS FIRST`,
  )).rows;
}

module.exports = { deliverQueuedEmails, outboxRows };
