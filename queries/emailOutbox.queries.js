// queries/emailOutbox.queries.js
//
// The email outbox (database/migrations/email_outbox_migration.sql), drained
// by services/email/outbox.js. Each row is one email to one address.

// Matches uq_email_outbox_dedupe exactly, or ON CONFLICT can't use it.
const ON_CONFLICT = `ON CONFLICT (kind, LOWER(COALESCE(recipient_email, '')), dedupe_key) DO NOTHING`;

const COLUMNS = `id, kind, school::text AS school, recipient_user_id, recipient_email, subject_type, subject_id,
  class_id, student_id, dedupe_key, coalesce_key, payload, priority, send_after, status, attempts,
  error_count, created_by, created_at`;

const emailOutboxQueries = {
  // Rows as JSON: one INSERT for the lot, inside the caller's transaction.
  // A 'skipped' row (nobody to email) is finished as it is written.
  // $1 jsonb array of rows
  insertJobs: `
    INSERT INTO email_outbox
      (kind, school, recipient_user_id, recipient_email, subject_type, subject_id, class_id, student_id,
       dedupe_key, coalesce_key, payload, priority, send_after, status, skip_reason, created_by, finished_at)
    SELECT r.kind, r.school::school, r.recipient_user_id, r.recipient_email, r.subject_type, r.subject_id,
           r.class_id, r.student_id, r.dedupe_key, r.coalesce_key, COALESCE(r.payload, '{}'::jsonb),
           COALESCE(r.priority, 5), NOW() + make_interval(secs => COALESCE(r.delay_seconds, 0)),
           COALESCE(r.status, 'pending'), r.skip_reason, r.created_by,
           CASE WHEN COALESCE(r.status, 'pending') = 'pending' THEN NULL ELSE NOW() END
    FROM jsonb_to_recordset($1::jsonb) AS r(
      kind TEXT, school TEXT, recipient_user_id UUID, recipient_email TEXT, subject_type TEXT, subject_id UUID,
      class_id UUID, student_id UUID, dedupe_key TEXT, coalesce_key TEXT, payload JSONB, priority SMALLINT,
      delay_seconds INT, status TEXT, skip_reason TEXT, created_by UUID)
    ${ON_CONFLICT}
    RETURNING id`,

  // The next due row, leased for 5 minutes: a worker that dies mid-send
  // leaves it to be picked up again once the lease runs out. A row with a
  // coalesce key is claimable only as the oldest pending row of its group
  // (same kind, address and key): two workers then race for the same row
  // (SKIP LOCKED gives it to one), and the winner takes the rest of the
  // group as siblings, so a family never gets two emails for one group.
  claimDue: `
    UPDATE email_outbox
    SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes'
    WHERE id = (
      SELECT o.id FROM email_outbox o
      WHERE o.status = 'pending' AND o.send_after <= NOW()
        AND (o.coalesce_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM email_outbox e
          WHERE e.status = 'pending' AND e.kind = o.kind AND e.coalesce_key = o.coalesce_key
            AND LOWER(e.recipient_email) = LOWER(o.recipient_email)
            AND (e.created_at, e.id) < (o.created_at, o.id)))
      ORDER BY o.priority, o.send_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${COLUMNS}`,

  // The address's other pending rows with the same coalesce key, taken with
  // the claimed one so they go out as one email (leased the same way). Only
  // rows nobody holds: never claimed, or a retry whose wait is over.
  // $1 kind, $2 address, $3 coalesce key, $4 the claimed row
  claimSiblings: `
    UPDATE email_outbox
    SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes'
    WHERE id IN (
      SELECT id FROM email_outbox
      WHERE kind = $1 AND LOWER(recipient_email) = LOWER($2) AND coalesce_key = $3
        AND status = 'pending' AND id <> $4 AND (attempts = 0 OR send_after <= NOW())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
    )
    RETURNING ${COLUMNS}`,

  // The sent row and the rows that rode in its email, together.
  // $1 id, $2 provider message id, $3 sent_content json, $4 merged row ids
  finishSent: `
    UPDATE email_outbox
    SET status = 'sent', last_error = NULL, finished_at = NOW(),
        provider_message_id = CASE WHEN id = $1 THEN $2 ELSE NULL END,
        sent_content = CASE WHEN id = $1 THEN $3::jsonb ELSE NULL END,
        merged_into = CASE WHEN id = $1 THEN NULL ELSE $1::uuid END
    WHERE id = $1 OR id = ANY($4::uuid[])`,

  // $1 ids, $2 reason
  finishSkipped: `
    UPDATE email_outbox
    SET status = 'skipped', skip_reason = $2, finished_at = NOW()
    WHERE id = ANY($1::uuid[])`,

  // A failed send: failed now when permanent or out of attempts, else back
  // to pending after attempts × 5 minutes. error_count rises only when Resend
  // definitely refused the email ($4), so a retry after a timeout or crash
  // reuses the idempotency key. $1 ids, $2 error, $3 max attempts, $4 refused, $5 permanent
  retryOrFail: `
    UPDATE email_outbox
    SET status = CASE WHEN $5::boolean OR attempts >= $3 THEN 'failed' ELSE 'pending' END,
        last_error = $2,
        error_count = error_count + CASE WHEN $4::boolean OR $5::boolean THEN 1 ELSE 0 END,
        send_after = NOW() + (attempts * interval '5 minutes'),
        finished_at = CASE WHEN $5::boolean OR attempts >= $3 THEN NOW() ELSE NULL END
    WHERE id = ANY($1::uuid[])`,

  // Manual Retry: failed rows of one subject back to pending, due now, with
  // a fresh attempt budget and a new idempotency key. $1 subject_type, $2 subject_id, $3 ids
  requeueFailed: `
    UPDATE email_outbox
    SET status = 'pending', attempts = 0, error_count = error_count + 1, send_after = NOW(),
        finished_at = NULL, merged_into = NULL
    WHERE subject_type = $1 AND subject_id = $2 AND status = 'failed' AND id = ANY($3::uuid[])
    RETURNING id`,

  // Every row about one subject, by student. $1 subject_type, $2 subject_id
  selectBySubject: `
    SELECT o.id, o.kind, o.recipient_email, o.student_id, s.name AS student_name, o.status, o.attempts,
           o.error_count, o.last_error, o.skip_reason, o.merged_into, o.send_after, o.created_at, o.finished_at,
           o.payload
    FROM email_outbox o
    LEFT JOIN students s ON s.student_id = o.student_id
    WHERE o.subject_type = $1 AND o.subject_id = $2
    ORDER BY s.name NULLS LAST, o.recipient_email NULLS FIRST, o.created_at`,
};

// Rows about several subjects, for counts. $1 subject_type, $2 subject ids
emailOutboxQueries.selectBySubjects = `
    SELECT o.subject_id, o.student_id, o.recipient_email, o.status, o.skip_reason, o.last_error, o.finished_at
    FROM email_outbox o
    WHERE o.subject_type = $1 AND o.subject_id = ANY($2::uuid[])`;

module.exports = emailOutboxQueries;
