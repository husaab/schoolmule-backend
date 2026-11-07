// queries/reportGeneration.queries.js
//
// Report generation in the background (services/reportGeneration/): a run is
// one press of Generate, an item one student of it. The worker's claim and
// finish queries live here too.

// An item as a page sees it: pending splits into printing (claimed, lease
// live) and queued.
const ITEM_STATUS = `
  CASE
    WHEN i.status = 'pending' AND i.claimed_until > NOW() THEN 'printing'
    WHEN i.status = 'pending' THEN 'queued'
    ELSE i.status
  END`;

// A run as a page sees it. stalled: something is waiting and nothing has
// finished in 5 minutes (counted from when it was queued if nothing has).
const RUN_COLUMNS = `
  r.run_id, r.report_type, r.term, r.student_count, r.created_at, r.finished_at, r.created_by,
  NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS created_by_name,
  (r.finished_at IS NULL
   AND EXISTS (SELECT 1 FROM report_generation_items p WHERE p.run_id = r.run_id AND p.status = 'pending')
   AND GREATEST(r.queued_at, (SELECT MAX(f.finished_at) FROM report_generation_items f WHERE f.run_id = r.run_id))
       < NOW() - interval '5 minutes') AS stalled`;

const reportGenerationQueries = {
  // One Generate at a time per school, report and term, so two presses at
  // once can't both queue the same student. $1 key text
  lockRuns: `SELECT pg_advisory_xact_lock(hashtext($1))`,

  // The students named, in this school (and year, when one is selected).
  // $1 student ids, $2 school, $3 school_year_id|null
  selectStudentsInScope: `
    SELECT student_id
    FROM students
    WHERE student_id = ANY($1::uuid[]) AND school = $2 AND ($3::uuid IS NULL OR school_year_id = $3)`,

  // Of these students, who is waiting already for this report and term.
  // $1 school, $2 report_type, $3 term, $4 student ids
  selectWaitingStudents: `
    SELECT DISTINCT i.student_id
    FROM report_generation_items i
    JOIN report_generation_runs r ON r.run_id = i.run_id
    WHERE r.school = $1 AND r.report_type = $2 AND r.term = $3
      AND i.status = 'pending' AND i.student_id = ANY($4::uuid[])`,

  // $1 school, $2 school_year_id, $3 report_type, $4 term, $5 report_date, $6 student count, $7 created_by
  insertRun: `
    INSERT INTO report_generation_runs (school, school_year_id, report_type, term, report_date, student_count, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING run_id`,

  // One item per student, in the order given. $1 run_id, $2 student ids
  insertItems: `
    INSERT INTO report_generation_items (run_id, student_id, position)
    SELECT $1, t.student_id, t.n - 1
    FROM unnest($2::uuid[]) WITH ORDINALITY AS t(student_id, n)`,

  // What a page lists: this school, year, report and term; running, or
  // finished and not dismissed in the last 14 days (a one-student run for a
  // minute, long enough for the page that started it to read the result).
  // Oldest first, so a later run decides a student's state.
  // $1 school, $2 school_year_id|null, $3 report_type, $4 term
  selectListedRuns: `
    SELECT ${RUN_COLUMNS}
    FROM report_generation_runs r
    LEFT JOIN users u ON u.user_id = r.created_by
    WHERE r.school = $1 AND r.school_year_id IS NOT DISTINCT FROM $2::uuid
      AND r.report_type = $3 AND r.term = $4
      AND r.dismissed_at IS NULL
      AND (r.finished_at IS NULL
           OR r.finished_at > NOW() - CASE WHEN r.student_count = 1 THEN interval '1 minute' ELSE interval '14 days' END)
    ORDER BY r.created_at, r.run_id`,

  // Runs by id, in the caller's school. $1 run ids, $2 school
  selectRunsById: `
    SELECT ${RUN_COLUMNS}
    FROM report_generation_runs r
    LEFT JOIN users u ON u.user_id = r.created_by
    WHERE r.run_id = ANY($1::uuid[]) AND r.school = $2
    ORDER BY r.created_at, r.run_id`,

  // $1 run ids
  selectItems: `
    SELECT i.run_id, i.student_id, ${ITEM_STATUS} AS status, i.error, i.finished_at
    FROM report_generation_items i
    WHERE i.run_id = ANY($1::uuid[])
    ORDER BY i.run_id, i.position`,

  // A run's school, report and term, for its lock. $1 run_id, $2 school
  selectRunForUpdate: `
    SELECT run_id, school::text AS school, report_type, term, finished_at
    FROM report_generation_runs
    WHERE run_id = $1 AND school = $2`,

  // Stop: what isn't printing now won't be. $1 run_id
  cancelPendingItems: `
    UPDATE report_generation_items
    SET status = 'cancelled', claimed_until = NULL, finished_at = NOW()
    WHERE run_id = $1 AND status = 'pending' AND (claimed_until IS NULL OR claimed_until <= NOW())`,

  // Try again: failed items wait again (only these students, when named),
  // unless the student is waiting in another run of this report and term already.
  // $1 run_id, $2 school, $3 report_type, $4 term, $5 student ids|null
  requeueFailedItems: `
    UPDATE report_generation_items i
    SET status = 'pending', attempts = 0, error = NULL, claimed_until = NULL, finished_at = NULL
    WHERE i.run_id = $1 AND i.status = 'failed'
      AND ($5::uuid[] IS NULL OR i.student_id = ANY($5::uuid[]))
      AND NOT EXISTS (
        SELECT 1 FROM report_generation_items o
        JOIN report_generation_runs orun ON orun.run_id = o.run_id
        WHERE o.student_id = i.student_id AND o.status = 'pending'
          AND orun.school = $2 AND orun.report_type = $3 AND orun.term = $4
      )`,

  // $1 run_id
  reopenRun: `
    UPDATE report_generation_runs
    SET finished_at = NULL, dismissed_at = NULL, queued_at = NOW()
    WHERE run_id = $1`,

  // $1 run_id
  dismissRun: `UPDATE report_generation_runs SET dismissed_at = NOW() WHERE run_id = $1`,

  // ── The worker ──

  // Claims the next student to print, with a 2-minute lease: from the run
  // served longest ago (a run never served first), in the run's order. An
  // item whose lease ran out (its server died mid-print) is claimed again.
  claimNextItem: `
    WITH next AS (
      SELECT x.run_id, x.student_id
      FROM report_generation_items x
      JOIN report_generation_runs r ON r.run_id = x.run_id
      WHERE x.status = 'pending' AND (x.claimed_until IS NULL OR x.claimed_until < NOW())
      ORDER BY r.last_served_at NULLS FIRST, r.created_at, x.position
      FOR UPDATE OF x SKIP LOCKED
      LIMIT 1
    )
    UPDATE report_generation_items i
    SET attempts = i.attempts + 1, claimed_until = NOW() + interval '2 minutes'
    FROM next, report_generation_runs r
    WHERE i.run_id = next.run_id AND i.student_id = next.student_id AND r.run_id = i.run_id
    RETURNING i.run_id, i.student_id, i.attempts, r.report_type, r.term,
              to_char(r.report_date, 'YYYY-MM-DD') AS report_date, r.school::text AS school`,

  // The turn order between runs; needn't be atomic with the claim. $1 run_id
  markRunServed: `UPDATE report_generation_runs SET last_served_at = NOW() WHERE run_id = $1`,

  // $1 run_id, $2 student_id
  markItemGenerated: `
    UPDATE report_generation_items
    SET status = 'generated', error = NULL, claimed_until = NULL, finished_at = NOW()
    WHERE run_id = $1 AND student_id = $2 AND status = 'pending'`,

  // $1 run_id, $2 student_id, $3 error
  markItemFailed: `
    UPDATE report_generation_items
    SET status = 'failed', error = $3, claimed_until = NULL, finished_at = NOW()
    WHERE run_id = $1 AND student_id = $2 AND status = 'pending'`,

  // A print that timed out: back in the queue for another attempt. $1 run_id, $2 student_id
  releaseItem: `
    UPDATE report_generation_items
    SET claimed_until = NULL
    WHERE run_id = $1 AND student_id = $2 AND status = 'pending'`,

  // ── The finish email (services/reportGeneration/doneEmail.js) ──

  // Whether a finished run gets its email: what was stopped, and the
  // starter's address. $1 run_id
  selectDoneRecipient: `
    SELECT (SELECT COUNT(*)::int FROM report_generation_items i WHERE i.run_id = r.run_id AND i.status = 'cancelled') AS cancelled,
           u.user_id, u.email
    FROM report_generation_runs r
    LEFT JOIN users u ON u.user_id = r.created_by
    WHERE r.run_id = $1`,

  // The counts, read when the email is sent. $1 run_id
  selectDoneCounts: `
    SELECT r.run_id, r.school::text AS school, r.report_type, r.term,
           COUNT(*) FILTER (WHERE i.status = 'generated')::int AS generated,
           COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed
    FROM report_generation_runs r
    JOIN report_generation_items i ON i.run_id = r.run_id
    WHERE r.run_id = $1
    GROUP BY r.run_id`,

  // Runs left open with nothing waiting: a server died between a run's last
  // report and finishing it. The worker sweeps them when the queue is empty.
  finishStrandedRuns: `
    UPDATE report_generation_runs r
    SET finished_at = NOW()
    WHERE r.finished_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM report_generation_items i WHERE i.run_id = r.run_id AND i.status = 'pending')
    RETURNING r.run_id, r.school::text AS school, r.report_type, r.term, r.student_count, r.created_by, r.finished_at`,

  // Finishes a run once nothing waits. Only one caller gets the row back,
  // however many finish at once. $1 run_id
  finishRunIfDone: `
    UPDATE report_generation_runs r
    SET finished_at = NOW()
    WHERE r.run_id = $1 AND r.finished_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM report_generation_items i WHERE i.run_id = r.run_id AND i.status = 'pending')
    RETURNING r.run_id, r.school::text AS school, r.report_type, r.term, r.student_count, r.created_by, r.finished_at`,
};

module.exports = reportGenerationQueries;
