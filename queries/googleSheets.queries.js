// queries/googleSheets.queries.js
//
// SQL for the Google Sheets sync: the per-school connection, each form's link
// to a spreadsheet tab, and the outbox that drives writes.
//
// Anything reached by form id is school-scoped through registration_forms, so a
// form id from another tenant matches nothing rather than leaking a row.

const googleSheetsQueries = {
  // ─── Connection (one Google account per school) ───────────────────────

  selectConnection: `
    SELECT connection_id, school, google_email, refresh_token, status,
           connected_by, connected_at
    FROM google_connections
    WHERE school = $1
  `,

  // Reconnecting replaces the stored grant and clears any needs_reconnect flag.
  upsertConnection: `
    INSERT INTO google_connections (school, google_email, refresh_token, connected_by, status)
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT (school) DO UPDATE
      SET google_email  = EXCLUDED.google_email,
          refresh_token = EXCLUDED.refresh_token,
          connected_by  = EXCLUDED.connected_by,
          status        = 'active',
          updated_at    = now()
    RETURNING connection_id, school, google_email, status, connected_at
  `,

  // Set when Google reports invalid_grant. Distinct from a sync failure: no
  // amount of retrying revives a revoked grant, only a human reconnecting.
  markConnectionNeedsReconnect: `
    UPDATE google_connections
    SET status = 'needs_reconnect', updated_at = now()
    WHERE school = $1
    RETURNING connection_id, school, google_email, status
  `,

  deleteConnection: `
    DELETE FROM google_connections WHERE school = $1 RETURNING connection_id
  `,

  // ─── Form → sheet link ────────────────────────────────────────────────

  selectLinkByForm: `
    SELECT l.*
    FROM form_sheet_links l
    JOIN registration_forms f ON l.form_id = f.form_id
    WHERE l.form_id = $1 AND f.school = $2
  `,

  // Used by the worker, which has a form id but no request context. Safe
  // because a job row can only exist for a form that already has a link.
  selectLinkByFormUnscoped: `
    SELECT l.*, f.school
    FROM form_sheet_links l
    JOIN registration_forms f ON l.form_id = f.form_id
    WHERE l.form_id = $1
  `,

  upsertLink: `
    INSERT INTO form_sheet_links
      (form_id, spreadsheet_id, spreadsheet_name, sheet_tab_id, sheet_tab_name, owned_columns)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (form_id) DO UPDATE
      SET spreadsheet_id   = EXCLUDED.spreadsheet_id,
          spreadsheet_name = EXCLUDED.spreadsheet_name,
          sheet_tab_id     = EXCLUDED.sheet_tab_id,
          sheet_tab_name   = EXCLUDED.sheet_tab_name,
          owned_columns    = EXCLUDED.owned_columns,
          last_error       = NULL,
          last_synced_at   = NULL
    RETURNING *
  `,

  // Unlinking only forgets the link. The spreadsheet and its contents are the
  // school's, and are never modified or deleted by us.
  deleteLink: `
    DELETE FROM form_sheet_links l
    USING registration_forms f
    WHERE l.form_id = $1 AND l.form_id = f.form_id AND f.school = $2
    RETURNING l.link_id
  `,

  updateLinkSynced: `
    UPDATE form_sheet_links
    SET last_synced_at = now(), last_error = NULL, owned_columns = $2
    WHERE form_id = $1
    RETURNING *
  `,

  updateLinkError: `
    UPDATE form_sheet_links
    SET last_error = $2
    WHERE form_id = $1
    RETURNING *
  `,

  // ─── Outbox ───────────────────────────────────────────────────────────

  // Coalescing enqueue. The partial unique index on (form_id) WHERE state IN
  // ('pending','running') makes ON CONFLICT a no-op when this form already has
  // a live job, so a burst of edits yields one write. The EXISTS guard keeps
  // jobs from piling up for forms nobody has linked a sheet to.
  enqueueJob: `
    INSERT INTO sheet_sync_jobs (form_id)
    SELECT $1
    WHERE EXISTS (SELECT 1 FROM form_sheet_links WHERE form_id = $1)
    ON CONFLICT DO NOTHING
    RETURNING job_id
  `,

  // SKIP LOCKED lets several server instances drain the queue concurrently
  // without ever handing the same job to two workers.
  claimNextJob: `
    UPDATE sheet_sync_jobs
    SET state = 'running', attempts = attempts + 1
    WHERE job_id = (
      SELECT job_id FROM sheet_sync_jobs
      WHERE state = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `,

  completeJob: `
    DELETE FROM sheet_sync_jobs WHERE job_id = $1 RETURNING job_id
  `,

  // Requeue with exponential backoff, or give up once attempts reach the cap
  // ($3). A failed job stays visible so the UI can explain the stall.
  failJob: `
    UPDATE sheet_sync_jobs
    SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
        last_error = $2,
        next_attempt_at = now() + (interval '1 second' * power(4, attempts))
    WHERE job_id = $1
    RETURNING *
  `,

  // Terminal failure: a revoked grant can't be fixed by retrying.
  failJobPermanently: `
    UPDATE sheet_sync_jobs
    SET state = 'failed', last_error = $2
    WHERE job_id = $1
    RETURNING *
  `,

  selectJobForForm: `
    SELECT job_id, state, attempts, next_attempt_at, last_error
    FROM sheet_sync_jobs
    WHERE form_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,

  // ─── Rows to write ────────────────────────────────────────────────────

  // Oldest first, so appended rows land in chronological order. status_label
  // resolves the stored key through the school's status vocabulary, falling
  // back to the raw key if a status was deleted out from under a submission.
  selectSubmissionsForSync: `
    SELECT s.submission_id, s.answers, s.submitted_at, s.status,
           COALESCE(st.label, s.status) AS status_label
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    LEFT JOIN registration_statuses st
      ON st.school = s.school AND st.key = s.status
    WHERE s.form_id = $1 AND f.school = $2
    ORDER BY s.submitted_at ASC
  `,
};

module.exports = googleSheetsQueries;
