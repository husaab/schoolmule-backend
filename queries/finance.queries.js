// queries/finance.queries.js
//
// SQL for the Finance → Tuition feature: the per-school QuickBooks connection,
// the cached QBO entities, the sync outbox/run log, and the family model.
//
// Every statement takes the school as a parameter and never trusts a school
// from the request body. Money columns are NUMERIC and come back as strings
// from pg; callers convert.

const financeQueries = {
  // ─── Connection ───────────────────────────────────────────────────────

  selectConnection: `
    SELECT connection_id, school, realm_id, company_name, refresh_token, refresh_token_version,
           access_token, access_token_expires_at, status, settings, cdc_cursor, backfill_completed_at,
           last_success_at, last_error, consecutive_failures, alerted_at, connected_by, connected_at, updated_at
    FROM finance_qbo_connections
    WHERE school = $1
  `,

  // Same row, locked: serializes token refreshes across server instances so
  // only one process ever spends the (single-use, rotating) refresh token.
  selectConnectionForUpdate: `
    SELECT connection_id, school, realm_id, refresh_token, refresh_token_version,
           access_token, access_token_expires_at, status
    FROM finance_qbo_connections
    WHERE school = $1
    FOR UPDATE
  `,

  // $1 school, $2 enc refresh, $3 enc access, $4 seconds until access expiry, $5 expected version.
  // The version guard is an assertion under the row lock; 0 rows means our read went stale.
  updateTokens: `
    UPDATE finance_qbo_connections
    SET refresh_token = $2,
        access_token = $3,
        access_token_expires_at = now() + ($4::int * interval '1 second'),
        refresh_token_version = refresh_token_version + 1,
        updated_at = now()
    WHERE school = $1 AND refresh_token_version = $5
    RETURNING connection_id, refresh_token_version
  `,

  markConnectionNeedsReconnect: `
    UPDATE finance_qbo_connections
    SET status = 'needs_reconnect', updated_at = now()
    WHERE school = $1
    RETURNING connection_id, status
  `,

  // Connecting (or reconnecting) replaces the grant and restarts the sync
  // cursor. $1 school, $2 realm, $3 company name, $4 enc refresh, $5 enc access,
  // $6 access ttl seconds, $7 connected_by, $8 settings jsonb.
  upsertConnection: `
    INSERT INTO finance_qbo_connections
      (school, realm_id, company_name, refresh_token, access_token, access_token_expires_at,
       refresh_token_version, status, settings, connected_by, cdc_cursor, backfill_completed_at,
       last_error, consecutive_failures, alerted_at)
    VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 second'), 1, 'active',
            COALESCE($8::jsonb, '{}'::jsonb), $7, NULL, NULL, NULL, 0, NULL)
    ON CONFLICT (school) DO UPDATE
      SET realm_id = EXCLUDED.realm_id,
          company_name = EXCLUDED.company_name,
          refresh_token = EXCLUDED.refresh_token,
          access_token = EXCLUDED.access_token,
          access_token_expires_at = EXCLUDED.access_token_expires_at,
          refresh_token_version = finance_qbo_connections.refresh_token_version + 1,
          status = 'active',
          settings = CASE WHEN $8::jsonb IS NULL THEN finance_qbo_connections.settings ELSE $8::jsonb END,
          connected_by = EXCLUDED.connected_by,
          connected_at = now(),
          last_error = NULL,
          consecutive_failures = 0,
          alerted_at = NULL,
          updated_at = now()
    RETURNING connection_id, school, realm_id, company_name, status, settings, connected_at
  `,

  // Disconnect keeps the cache readable; only the grant is dropped.
  disconnectConnection: `
    UPDATE finance_qbo_connections
    SET status = 'disconnected', refresh_token = NULL, access_token = NULL,
        access_token_expires_at = NULL, updated_at = now()
    WHERE school = $1
    RETURNING connection_id, realm_id
  `,

  // Purge: the row goes, and every cached qbo_* row cascades with it.
  deleteConnection: `
    DELETE FROM finance_qbo_connections WHERE school = $1 RETURNING connection_id
  `,

  updateConnectionSettings: `
    UPDATE finance_qbo_connections
    SET settings = settings || $2::jsonb, updated_at = now()
    WHERE school = $1
    RETURNING settings
  `,

  // Who gets the sync-failure email when FINANCE_ALERT_EMAIL is not set.
  selectAdminEmails: `
    SELECT email FROM users
    WHERE school = $1 AND role = 'ADMIN' AND is_verified_school = true AND is_archived = false
  `,

  markAlerted: `
    UPDATE finance_qbo_connections SET alerted_at = now() WHERE school = $1
  `,

  // ─── Sync runs ────────────────────────────────────────────────────────

  // $1 school, $2 job_id, $3 kind, $4 mode, $5 cursor_from, $6 triggered_by
  insertRun: `
    INSERT INTO finance_sync_runs (school, job_id, kind, mode, cursor_from, triggered_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING run_id, started_at
  `,

  // $1 run_id, $2 customers, $3 invoices, $4 payments, $5 deleted, $6 api_calls, $7 cursor_to
  finishRun: `
    UPDATE finance_sync_runs
    SET status = 'success', finished_at = now(), customers_upserted = $2, invoices_upserted = $3,
        payments_upserted = $4, deleted_flagged = $5, api_calls = $6, cursor_to = $7
    WHERE run_id = $1
    RETURNING run_id
  `,

  // $1 run_id, $2 error, $3 api_calls
  failRun: `
    UPDATE finance_sync_runs
    SET status = 'failed', finished_at = now(), error = $2, api_calls = $3
    WHERE run_id = $1
    RETURNING run_id
  `,

  // $1 school, $2 cursor_to. backfill_completed_at is only ever unset before the
  // first full run, so COALESCE is correct in both modes.
  recordSyncSuccess: `
    UPDATE finance_qbo_connections
    SET cdc_cursor = $2,
        last_success_at = now(),
        last_error = NULL,
        consecutive_failures = 0,
        backfill_completed_at = COALESCE(backfill_completed_at, now()),
        updated_at = now()
    WHERE school = $1
    RETURNING connection_id
  `,

  // $1 school, $2 error message
  recordSyncFailure: `
    UPDATE finance_qbo_connections
    SET consecutive_failures = consecutive_failures + 1,
        last_error = $2,
        updated_at = now()
    WHERE school = $1
    RETURNING consecutive_failures, alerted_at, connected_by
  `,

  selectRecentRuns: `
    SELECT run_id, job_id, kind, mode, status, started_at, finished_at, cursor_from, cursor_to,
           customers_upserted, invoices_upserted, payments_upserted, deleted_flagged, api_calls, error, triggered_by
    FROM finance_sync_runs
    WHERE school = $1
    ORDER BY started_at DESC
    LIMIT $2 OFFSET $3
  `,

  countRuns: `
    SELECT count(*)::int AS total FROM finance_sync_runs WHERE school = $1
  `,

  selectLastRun: `
    SELECT run_id, kind, mode, status, started_at, finished_at, invoices_upserted, payments_upserted, error
    FROM finance_sync_runs
    WHERE school = $1
    ORDER BY started_at DESC
    LIMIT 1
  `,

  selectRecentErrors: `
    SELECT error FROM finance_sync_runs
    WHERE school = $1 AND status = 'failed' AND error IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 3
  `,

  // Sync-now throttle: a manual run started in the last minute.
  selectRecentManualRun: `
    SELECT run_id FROM finance_sync_runs
    WHERE school = $1 AND kind = 'manual' AND started_at > now() - interval '60 seconds'
    LIMIT 1
  `,

  pruneRuns: `
    DELETE FROM finance_sync_runs WHERE started_at < now() - interval '90 days'
  `,

  clearStaleAlerts: `
    UPDATE finance_qbo_connections SET alerted_at = NULL WHERE consecutive_failures = 0 AND alerted_at IS NOT NULL
  `,

  // Failed jobs stay visible for a week so the UI can explain a stall, then go.
  pruneFailedJobs: `
    DELETE FROM finance_sync_jobs WHERE state = 'failed' AND created_at < now() - interval '7 days'
  `,

  // A run still 'running' hours later belongs to a worker that died mid-sync.
  failOrphanedRuns: `
    UPDATE finance_sync_runs
    SET status = 'failed', finished_at = now(), error = 'orphaned: the worker stopped before this run finished'
    WHERE status = 'running' AND started_at < now() - interval '2 hours'
  `,

  markRunFull: `
    UPDATE finance_sync_runs SET mode = 'full' WHERE run_id = $1
  `,

  // The OAuth callback re-checks the user the signed state names: they must
  // still be an active admin of that school at the moment the code arrives.
  selectUserForOAuth: `
    SELECT user_id, role, school, is_archived FROM users WHERE user_id = $1
  `,

  // ─── Sync outbox ──────────────────────────────────────────────────────

  // Coalescing enqueue: the partial unique index on (school) WHERE state IN
  // ('pending','running') turns a second live job into a no-op.
  // $1 school, $2 kind, $3 requested_by
  enqueueJob: `
    INSERT INTO finance_sync_jobs (school, kind, requested_by)
    SELECT $1, $2, $3
    WHERE EXISTS (SELECT 1 FROM finance_qbo_connections WHERE school = $1 AND status = 'active')
    ON CONFLICT DO NOTHING
    RETURNING job_id
  `,

  // The 15-minute schedule, expressed in SQL so several server instances stay
  // idempotent: a connection that has never completed a backfill gets one. A
  // school whose last job failed permanently waits out a cooldown first, so a
  // persistently failing realm is retried every half hour, not every tick.
  enqueueDueJobs: `
    INSERT INTO finance_sync_jobs (school, kind)
    SELECT c.school, CASE WHEN c.backfill_completed_at IS NULL THEN 'backfill' ELSE 'cdc' END
    FROM finance_qbo_connections c
    WHERE c.status = 'active'
      AND (c.last_success_at IS NULL OR c.last_success_at < now() - interval '15 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM finance_sync_jobs j
        WHERE j.school = c.school AND j.state = 'failed' AND j.failed_at > now() - interval '30 minutes'
      )
    ON CONFLICT DO NOTHING
    RETURNING job_id
  `,

  // SKIP LOCKED lets several instances drain concurrently. A 'running' job
  // whose lease is stale belongs to a worker that died mid-sync and is
  // reclaimed, so a crash can never park a school's sync forever.
  claimNextJob: `
    UPDATE finance_sync_jobs
    SET state = 'running', attempts = attempts + 1, claimed_at = now()
    WHERE job_id = (
      SELECT job_id FROM finance_sync_jobs
      WHERE (state = 'pending' AND next_attempt_at <= now())
         OR (state = 'running' AND claimed_at < now() - interval '30 minutes')
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `,

  completeJob: `
    DELETE FROM finance_sync_jobs WHERE job_id = $1 RETURNING job_id
  `,

  // $1 job_id, $2 error, $3 max attempts
  failJob: `
    UPDATE finance_sync_jobs
    SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
        failed_at = CASE WHEN attempts >= $3 THEN now() ELSE failed_at END,
        last_error = $2,
        next_attempt_at = now() + (interval '1 second' * power(4, attempts))
    WHERE job_id = $1
    RETURNING *
  `,

  failJobPermanently: `
    UPDATE finance_sync_jobs
    SET state = 'failed', failed_at = now(), last_error = $2
    WHERE job_id = $1
    RETURNING *
  `,

  selectLatestJob: `
    SELECT job_id, kind, state, attempts, next_attempt_at, last_error, requested_by, created_at
    FROM finance_sync_jobs
    WHERE school = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,

  // ─── Cache upserts (set-based, one statement per page) ────────────────

  // $1 school, $2 realm_id, $3 jsonb array of normalized customers
  upsertCustomers: `
    INSERT INTO qbo_customers
      (school, realm_id, qbo_id, display_name, fully_qualified_name, parent_qbo_id, is_sub_customer, active,
       balance, emails, phone, sync_token, last_updated_time, raw, synced_at)
    SELECT $1, $2, x.qbo_id, x.display_name, x.fully_qualified_name, x.parent_qbo_id, x.is_sub_customer, x.active,
           x.balance, COALESCE(x.emails, '{}'), x.phone, x.sync_token, COALESCE(x.last_updated_time, now()), x.raw, now()
    FROM jsonb_to_recordset($3::jsonb) AS x(
      qbo_id text, display_name text, fully_qualified_name text, parent_qbo_id text, is_sub_customer boolean,
      active boolean, balance numeric, emails text[], phone text, sync_token int, last_updated_time timestamptz, raw jsonb)
    ON CONFLICT (school, qbo_id) DO UPDATE
      SET display_name = EXCLUDED.display_name, fully_qualified_name = EXCLUDED.fully_qualified_name,
          parent_qbo_id = EXCLUDED.parent_qbo_id, is_sub_customer = EXCLUDED.is_sub_customer, active = EXCLUDED.active,
          balance = EXCLUDED.balance, emails = EXCLUDED.emails, phone = EXCLUDED.phone, sync_token = EXCLUDED.sync_token,
          last_updated_time = EXCLUDED.last_updated_time, raw = EXCLUDED.raw, synced_at = now(), deleted_at = NULL
      WHERE EXCLUDED.last_updated_time >= qbo_customers.last_updated_time OR qbo_customers.deleted_at IS NOT NULL
    RETURNING qbo_id
  `,

  // $1 school, $2 realm_id, $3 jsonb array of normalized invoices (lines excluded).
  // ">=" rather than ">" so a re-run with new classification rules rewrites rows.
  upsertInvoices: `
    INSERT INTO qbo_invoices
      (school, realm_id, qbo_id, doc_number, customer_qbo_id, txn_date, due_date, total_amt, balance, email_status,
       private_note, customer_memo, recurring_ref, sync_token, last_updated_time, is_voided, kind_auto, raw, synced_at)
    SELECT $1, $2, x.qbo_id, x.doc_number, x.customer_qbo_id, x.txn_date, x.due_date, x.total_amt, x.balance, x.email_status,
           x.private_note, x.customer_memo, x.recurring_ref, x.sync_token, COALESCE(x.last_updated_time, now()), x.is_voided, x.kind_auto, x.raw, now()
    FROM jsonb_to_recordset($3::jsonb) AS x(
      qbo_id text, doc_number text, customer_qbo_id text, txn_date date, due_date date, total_amt numeric, balance numeric,
      email_status text, private_note text, customer_memo text, recurring_ref text, sync_token int,
      last_updated_time timestamptz, is_voided boolean, kind_auto text, raw jsonb)
    ON CONFLICT (school, qbo_id) DO UPDATE
      SET doc_number = EXCLUDED.doc_number, customer_qbo_id = EXCLUDED.customer_qbo_id, txn_date = EXCLUDED.txn_date,
          due_date = EXCLUDED.due_date, total_amt = EXCLUDED.total_amt, balance = EXCLUDED.balance,
          email_status = EXCLUDED.email_status, private_note = EXCLUDED.private_note, customer_memo = EXCLUDED.customer_memo,
          recurring_ref = EXCLUDED.recurring_ref, sync_token = EXCLUDED.sync_token, last_updated_time = EXCLUDED.last_updated_time,
          is_voided = EXCLUDED.is_voided, kind_auto = EXCLUDED.kind_auto, raw = EXCLUDED.raw, synced_at = now(), deleted_at = NULL
      WHERE EXCLUDED.last_updated_time >= qbo_invoices.last_updated_time OR qbo_invoices.deleted_at IS NOT NULL
    RETURNING qbo_id
  `,

  deleteInvoiceLines: `
    DELETE FROM qbo_invoice_lines WHERE school = $1 AND invoice_qbo_id = ANY($2::text[])
  `,

  // $1 school, $2 jsonb array of lines (each carrying invoice_qbo_id)
  insertInvoiceLines: `
    INSERT INTO qbo_invoice_lines
      (school, invoice_qbo_id, line_num, line_id, detail_type, description, amount, item_ref, item_name, qty, unit_price, student_hint)
    SELECT $1, x.invoice_qbo_id, x.line_num, x.line_id, x.detail_type, x.description, COALESCE(x.amount, 0), x.item_ref,
           x.item_name, x.qty, x.unit_price, x.student_hint
    FROM jsonb_to_recordset($2::jsonb) AS x(
      invoice_qbo_id text, line_num int, line_id text, detail_type text, description text, amount numeric,
      item_ref text, item_name text, qty numeric, unit_price numeric, student_hint text)
    ON CONFLICT DO NOTHING
  `,

  // $1 school, $2 realm_id, $3 jsonb array of normalized payments (applications excluded)
  upsertPayments: `
    INSERT INTO qbo_payments
      (school, realm_id, qbo_id, customer_qbo_id, txn_date, total_amt, unapplied_amt, payment_method, payment_ref_num,
       private_note, deposit_account, sync_token, last_updated_time, raw, synced_at)
    SELECT $1, $2, x.qbo_id, x.customer_qbo_id, x.txn_date, x.total_amt, COALESCE(x.unapplied_amt, 0), x.payment_method,
           x.payment_ref_num, x.private_note, x.deposit_account, x.sync_token, COALESCE(x.last_updated_time, now()), x.raw, now()
    FROM jsonb_to_recordset($3::jsonb) AS x(
      qbo_id text, customer_qbo_id text, txn_date date, total_amt numeric, unapplied_amt numeric, payment_method text,
      payment_ref_num text, private_note text, deposit_account text, sync_token int, last_updated_time timestamptz, raw jsonb)
    ON CONFLICT (school, qbo_id) DO UPDATE
      SET customer_qbo_id = EXCLUDED.customer_qbo_id, txn_date = EXCLUDED.txn_date, total_amt = EXCLUDED.total_amt,
          unapplied_amt = EXCLUDED.unapplied_amt, payment_method = EXCLUDED.payment_method,
          payment_ref_num = EXCLUDED.payment_ref_num, private_note = EXCLUDED.private_note,
          deposit_account = EXCLUDED.deposit_account, sync_token = EXCLUDED.sync_token,
          last_updated_time = EXCLUDED.last_updated_time, raw = EXCLUDED.raw, synced_at = now(), deleted_at = NULL
      WHERE EXCLUDED.last_updated_time >= qbo_payments.last_updated_time OR qbo_payments.deleted_at IS NOT NULL
    RETURNING qbo_id
  `,

  deletePaymentApplications: `
    DELETE FROM qbo_payment_applications WHERE school = $1 AND payment_qbo_id = ANY($2::text[])
  `,

  // $1 school, $2 jsonb array of {payment_qbo_id, invoice_qbo_id, amount}
  insertPaymentApplications: `
    INSERT INTO qbo_payment_applications (school, payment_qbo_id, invoice_qbo_id, amount)
    SELECT $1, x.payment_qbo_id, x.invoice_qbo_id, x.amount
    FROM jsonb_to_recordset($2::jsonb) AS x(payment_qbo_id text, invoice_qbo_id text, amount numeric)
    ON CONFLICT (school, payment_qbo_id, invoice_qbo_id) DO UPDATE SET amount = EXCLUDED.amount
  `,

  // ─── Deletions (flag, never remove) ───────────────────────────────────

  flagInvoicesDeleted: `
    UPDATE qbo_invoices
    SET deleted_at = now()
    WHERE school = $1 AND qbo_id = ANY($2::text[]) AND deleted_at IS NULL
    RETURNING qbo_id
  `,

  flagPaymentsDeleted: `
    UPDATE qbo_payments
    SET deleted_at = now()
    WHERE school = $1 AND qbo_id = ANY($2::text[]) AND deleted_at IS NULL
    RETURNING qbo_id
  `,

  flagCustomersDeleted: `
    UPDATE qbo_customers
    SET deleted_at = now()
    WHERE school = $1 AND qbo_id = ANY($2::text[]) AND deleted_at IS NULL
    RETURNING qbo_id
  `,

  // After a full run: any cached invoice in the window that the run did not
  // touch no longer exists in QBO (deleted before CDC could tell us).
  // $1 school, $2 window start date, $3 run started_at
  sweepUnseenInvoices: `
    UPDATE qbo_invoices
    SET deleted_at = now()
    WHERE school = $1 AND txn_date >= $2::date AND deleted_at IS NULL AND synced_at < $3
    RETURNING qbo_id
  `,

  // Customers whose invoices show money received (total − balance) that our
  // cached payment applications cannot account for — the gap pass re-queries
  // their payments directly. $1 school, $2 window start date.
  selectCustomersWithUnexplainedPaid: `
    WITH unexplained AS (
      SELECT i.customer_qbo_id,
             SUM(i.total_amt - i.balance) AS paid,
             COALESCE(SUM(a.applied), 0) AS applied
      FROM qbo_invoices i
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount) AS applied
        FROM qbo_payment_applications pa
        JOIN qbo_payments p ON p.school = pa.school AND p.qbo_id = pa.payment_qbo_id AND p.deleted_at IS NULL
        WHERE pa.school = i.school AND pa.invoice_qbo_id = i.qbo_id
      ) a ON true
      WHERE i.school = $1 AND i.txn_date >= $2::date AND i.deleted_at IS NULL AND NOT i.is_voided
      GROUP BY i.customer_qbo_id
    )
    SELECT customer_qbo_id FROM unexplained WHERE paid - applied > 0.01
    LIMIT 50
  `,

  // ─── Families (read side) ─────────────────────────────────────────────

  selectFamiliesByYear: `
    SELECT family_id, school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent,
           expected_monthly_subsidy, notes, roster_family_no, created_by, created_at, updated_at
    FROM families
    WHERE school = $1 AND school_year_id = $2
    ORDER BY name
  `,

  selectFamilyById: `
    SELECT family_id, school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent,
           expected_monthly_subsidy, notes, roster_family_no, created_by, created_at, updated_at
    FROM families
    WHERE school = $1 AND family_id = $2
  `,

  // Students of every family in a year (grade cast: prod's column is an enum).
  selectFamilyStudentsByYear: `
    SELECT fs.family_id, s.student_id, s.name, s.grade::text AS grade, s.is_archived
    FROM family_students fs
    JOIN families f ON f.family_id = fs.family_id
    JOIN students s ON s.student_id = fs.student_id
    WHERE f.school = $1 AND f.school_year_id = $2
    ORDER BY s.name
  `,

  selectFamilyStudents: `
    SELECT fs.family_id, s.student_id, s.name, s.grade::text AS grade, s.is_archived, fs.added_at
    FROM family_students fs
    JOIN students s ON s.student_id = fs.student_id
    WHERE fs.family_id = $1
    ORDER BY s.name
  `,

  selectFamilyContactsByYear: `
    SELECT c.contact_id, c.family_id, c.name, c.email, c.phone, c.relation, c.is_primary, c.user_id, c.source
    FROM family_contacts c
    JOIN families f ON f.family_id = c.family_id
    WHERE f.school = $1 AND f.school_year_id = $2
    ORDER BY c.is_primary DESC, c.name
  `,

  selectFamilyContacts: `
    SELECT contact_id, family_id, name, email, phone, relation, is_primary, user_id, source, created_at, updated_at
    FROM family_contacts
    WHERE family_id = $1
    ORDER BY is_primary DESC, name
  `,

  // Newest range first so a lookup by date is deterministic.
  selectFamilyLinksByYear: `
    SELECT l.link_id, l.family_id, l.qbo_customer_id, l.effective_from, l.effective_to
    FROM family_customer_links l
    JOIN families f ON f.family_id = l.family_id
    WHERE l.school = $1 AND f.school_year_id = $2
    ORDER BY l.effective_from DESC
  `,

  selectFamilyLinks: `
    SELECT l.link_id, l.family_id, l.qbo_customer_id, l.effective_from, l.effective_to, l.created_at, l.created_by,
           c.display_name AS customer_name, c.is_sub_customer, c.active AS customer_active
    FROM family_customer_links l
    LEFT JOIN qbo_customers c ON c.school = l.school AND c.qbo_id = l.qbo_customer_id
    WHERE l.school = $1 AND l.family_id = $2
    ORDER BY l.effective_from
  `,

  // Active students of the year with no family yet — the "Students without a family" count.
  countStudentsWithoutFamily: `
    SELECT count(*)::int AS count
    FROM students s
    LEFT JOIN family_students fs ON fs.student_id = s.student_id
    WHERE s.school = $1 AND s.school_year_id = $2 AND s.is_archived = false AND fs.student_id IS NULL
  `,

  // ─── Cache reads ──────────────────────────────────────────────────────

  selectCustomerSummaries: `
    SELECT qbo_id, display_name, is_sub_customer, parent_qbo_id, active, emails, deleted_at
    FROM qbo_customers
    WHERE school = $1
  `,

  // Every invoice dated inside the school year's months, linked or not.
  // $1 school, $2 window start (first day of first month), $3 window end (last day of last month)
  selectInvoicesInWindow: `
    SELECT qbo_id, customer_qbo_id, doc_number, txn_date, due_date, total_amt, balance, kind, kind_auto, kind_override,
           is_voided, deleted_at, email_status, private_note, recurring_ref
    FROM qbo_invoices
    WHERE school = $1 AND txn_date >= $2::date AND txn_date <= $3::date
    ORDER BY txn_date, qbo_id
  `,

  // All invoices of a set of customers (a family's link history), any date.
  selectInvoicesForCustomers: `
    SELECT qbo_id, customer_qbo_id, doc_number, txn_date, due_date, total_amt, balance, kind, kind_auto, kind_override,
           is_voided, deleted_at, email_status, private_note, customer_memo, recurring_ref, last_updated_time
    FROM qbo_invoices
    WHERE school = $1 AND customer_qbo_id = ANY($2::text[])
    ORDER BY txn_date, qbo_id
  `,

  selectInvoiceLinesForInvoices: `
    SELECT invoice_qbo_id, line_num, line_id, detail_type, description, amount, item_ref, item_name, qty, unit_price, student_hint
    FROM qbo_invoice_lines
    WHERE school = $1 AND invoice_qbo_id = ANY($2::text[])
    ORDER BY invoice_qbo_id, line_num
  `,

  // Applications joined to their payment for the date and deletion flag.
  selectApplicationsForInvoices: `
    SELECT a.payment_qbo_id, a.invoice_qbo_id, a.amount,
           p.txn_date AS payment_date, p.payment_ref_num, p.payment_method, (p.deleted_at IS NOT NULL) AS payment_deleted
    FROM qbo_payment_applications a
    JOIN qbo_payments p ON p.school = a.school AND p.qbo_id = a.payment_qbo_id
    WHERE a.school = $1 AND a.invoice_qbo_id = ANY($2::text[])
    ORDER BY p.txn_date
  `,

  selectPaymentsForCustomers: `
    SELECT qbo_id, customer_qbo_id, txn_date, total_amt, unapplied_amt, payment_ref_num, payment_method, private_note, deleted_at
    FROM qbo_payments
    WHERE school = $1 AND customer_qbo_id = ANY($2::text[])
    ORDER BY txn_date DESC
  `,

  // ─── Audit ────────────────────────────────────────────────────────────

  selectAuditForFamily: `
    SELECT a.audit_id, a.action, a.old_qbo_customer_id, a.new_qbo_customer_id, a.student_id, a.invoice_qbo_id,
           a.details, a.actor_user_id, a.created_at, u.first_name AS actor_first_name, u.last_name AS actor_last_name
    FROM family_link_audit a
    LEFT JOIN users u ON u.user_id = a.actor_user_id
    WHERE a.school = $1 AND a.family_id = $2
    ORDER BY a.created_at DESC
    LIMIT $3
  `,

  // $1 school, $2 school_year_id, $3 family_id, $4 family_name, $5 action, $6 old customer, $7 new customer,
  // $8 student_id, $9 invoice id, $10 details jsonb, $11 actor
  insertAudit: `
    INSERT INTO family_link_audit
      (school, school_year_id, family_id, family_name, action, old_qbo_customer_id, new_qbo_customer_id,
       student_id, invoice_qbo_id, details, actor_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
    RETURNING audit_id
  `,

  // ─── Seeding (families from the roster + customer map) ────────────────

  selectYearByLabel: `
    SELECT school_year_id, school, label, start_date, end_date, is_active
    FROM school_years
    WHERE school = $1 AND label = $2
  `,

  // Candidates for name+grade matching, with the inline guardian fields the
  // contacts are built from.
  selectStudentsForSeed: `
    SELECT student_id, name, grade::text AS grade, mother_name, mother_email, mother_number,
           father_name, father_email, father_number
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
    ORDER BY name
  `,

  // Existing families of the year with their current customer, keyed by roster number.
  selectFamiliesWithCurrentCustomer: `
    SELECT f.family_id, f.roster_family_no, f.name, l.qbo_customer_id
    FROM families f
    LEFT JOIN family_customer_links l ON l.family_id = f.family_id AND l.effective_to IS NULL
    WHERE f.school = $1 AND f.school_year_id = $2
  `,

  selectAssignmentsByYear: `
    SELECT fs.student_id, fs.family_id
    FROM family_students fs
    JOIN families f ON f.family_id = fs.family_id
    WHERE f.school = $1 AND f.school_year_id = $2
  `,

  // $1 school, $2 year, $3 name, $4 is_subsidy, $5 is_teacher, $6 expected parent, $7 expected subsidy,
  // $8 notes, $9 roster_family_no, $10 created_by
  upsertFamilyFromSeed: `
    INSERT INTO families
      (school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent, expected_monthly_subsidy,
       notes, roster_family_no, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (school, school_year_id, roster_family_no) WHERE roster_family_no IS NOT NULL DO UPDATE
      SET name = EXCLUDED.name,
          is_subsidy = EXCLUDED.is_subsidy,
          is_teacher = EXCLUDED.is_teacher,
          expected_monthly_parent = EXCLUDED.expected_monthly_parent,
          expected_monthly_subsidy = EXCLUDED.expected_monthly_subsidy,
          notes = COALESCE(EXCLUDED.notes, families.notes),
          updated_at = now()
    RETURNING family_id, name
  `,

  selectOpenLinkForFamily: `
    SELECT link_id, qbo_customer_id, effective_from FROM family_customer_links
    WHERE family_id = $1 AND effective_to IS NULL
  `,

  // A seed correction replaces a wrong mapping outright. The link is removed
  // (a zero-length range would still claim invoices dated that day); the audit
  // row keeps the old customer id as history.
  deleteLink: `
    DELETE FROM family_customer_links WHERE link_id = $1 RETURNING link_id
  `,

  // $1 school, $2 family_id, $3 customer, $4 effective_from, $5 created_by. The year comes from the family.
  openLink: `
    INSERT INTO family_customer_links (school, family_id, school_year_id, qbo_customer_id, effective_from, created_by)
    SELECT $1, $2, f.school_year_id, $3, $4::date, $5 FROM families f WHERE f.family_id = $2 AND f.school = $1
    RETURNING link_id
  `,

  // Same school and school year as the family, enforced in the statement itself.
  insertFamilyStudent: `
    INSERT INTO family_students (family_id, student_id)
    SELECT $1, s.student_id
    FROM students s
    JOIN families f ON f.family_id = $1
    WHERE s.student_id = $2 AND s.school = f.school AND s.school_year_id = f.school_year_id
    ON CONFLICT (student_id) DO NOTHING
    RETURNING student_id
  `,

  selectFamilyOfStudent: `
    SELECT family_id FROM family_students WHERE student_id = $1
  `,

  // $1 family, $2 name, $3 email, $4 phone, $5 relation, $6 source
  upsertContactByEmail: `
    INSERT INTO family_contacts (family_id, name, email, phone, relation, source)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (family_id, lower(email)) WHERE email IS NOT NULL DO UPDATE
      SET name = COALESCE(family_contacts.name, EXCLUDED.name),
          phone = COALESCE(family_contacts.phone, EXCLUDED.phone),
          relation = COALESCE(family_contacts.relation, EXCLUDED.relation),
          updated_at = now()
    RETURNING contact_id
  `,

  // $1 family, $2 name, $3 phone, $4 relation, $5 source
  insertContactNameOnly: `
    INSERT INTO family_contacts (family_id, name, phone, relation, source)
    SELECT $1, $2, $3, $4, $5
    WHERE NOT EXISTS (SELECT 1 FROM family_contacts WHERE family_id = $1 AND lower(name) = lower($2))
    RETURNING contact_id
  `,

  // Exactly one primary per family. Two statements: the partial unique index is
  // checked row by row, so flipping both in one UPDATE can collide.
  clearPrimaryContact: `
    UPDATE family_contacts SET is_primary = false, updated_at = now()
    WHERE family_id = $1 AND is_primary AND contact_id <> $2
  `,
  setPrimaryContact: `
    UPDATE family_contacts SET is_primary = true, updated_at = now()
    WHERE family_id = $1 AND contact_id = $2 AND NOT is_primary
  `,

  // ─── Families (write side, admin UI) ──────────────────────────────────

  // $1 school, $2 year, $3 name, $4 is_subsidy, $5 is_teacher, $6 expected parent, $7 expected subsidy, $8 notes, $9 created_by
  insertFamily: `
    INSERT INTO families (school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent, expected_monthly_subsidy, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING family_id, school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent, expected_monthly_subsidy,
              notes, roster_family_no, created_at, updated_at
  `,

  // Full-row update; the controller merges the patch over the current row first.
  updateFamily: `
    UPDATE families
    SET name = $3, is_subsidy = $4, is_teacher = $5, expected_monthly_parent = $6, expected_monthly_subsidy = $7,
        notes = $8, updated_at = now()
    WHERE school = $1 AND family_id = $2
    RETURNING family_id, school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent, expected_monthly_subsidy,
              notes, roster_family_no, created_at, updated_at
  `,

  // Students, contacts and links cascade; the cache is untouched.
  deleteFamily: `
    DELETE FROM families WHERE school = $1 AND family_id = $2 RETURNING family_id
  `,

  selectCustomerById: `
    SELECT qbo_id, display_name, is_sub_customer, active, emails
    FROM qbo_customers
    WHERE school = $1 AND qbo_id = $2 AND deleted_at IS NULL
  `,

  // Which family (if any) currently bills through this customer, in this school year.
  selectOpenLinkForCustomer: `
    SELECT l.link_id, l.family_id, f.name FROM family_customer_links l
    JOIN families f ON f.family_id = l.family_id
    WHERE l.school = $1 AND l.qbo_customer_id = $2 AND l.school_year_id = $3 AND l.effective_to IS NULL
  `,

  // The latest date another family's closed link to this customer still covers.
  // A new link must start after it, or two families would claim the same invoices.
  // $1 school, $2 customer, $3 year, $4 the family being linked (its own history is ignored)
  selectLatestClosedLinkForCustomer: `
    SELECT MAX(effective_to)::text AS latest_to
    FROM family_customer_links
    WHERE school = $1 AND qbo_customer_id = $2 AND school_year_id = $3 AND family_id <> $4 AND effective_to IS NOT NULL
  `,

  // Every open link of the year with its family, for the import pre-check.
  selectOpenLinksByYear: `
    SELECT l.family_id, f.name AS family_name, l.qbo_customer_id, f.roster_family_no
    FROM family_customer_links l
    JOIN families f ON f.family_id = l.family_id
    WHERE l.school = $1 AND l.school_year_id = $2 AND l.effective_to IS NULL
  `,

  // $1 link_id, $2 effective_to (the day before the replacement starts, or today for an unlink)
  closeLink: `
    UPDATE family_customer_links
    SET effective_to = $2::date
    WHERE link_id = $1 AND effective_to IS NULL
    RETURNING link_id
  `,

  // Scoped to the school and year: a foreign id must read as "not in this year", never leak a name.
  selectFamilyHoldingStudent: `
    SELECT f.family_id, f.name FROM family_students fs
    JOIN families f ON f.family_id = fs.family_id
    WHERE fs.student_id = $1 AND f.school = $2 AND f.school_year_id = $3
  `,

  deleteFamilyStudent: `
    DELETE FROM family_students WHERE family_id = $1 AND student_id = $2 RETURNING student_id
  `,

  // $1 family, $2 name, $3 email (lower-cased by the controller), $4 phone, $5 relation, $6 source
  insertContact: `
    INSERT INTO family_contacts (family_id, name, email, phone, relation, source)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING contact_id
  `,

  // $1 family, $2 contact_id, $3 name, $4 email, $5 phone, $6 relation
  updateContact: `
    UPDATE family_contacts
    SET name = $3, email = $4, phone = $5, relation = $6, updated_at = now()
    WHERE family_id = $1 AND contact_id = $2
    RETURNING contact_id
  `,

  deleteContact: `
    DELETE FROM family_contacts WHERE family_id = $1 AND contact_id = $2 RETURNING contact_id
  `,

  selectContact: `
    SELECT contact_id, family_id, name, email, phone, relation, is_primary, user_id, source
    FROM family_contacts WHERE family_id = $1 AND contact_id = $2
  `,

  // $1 school, $2 qbo invoice id, $3 kind or NULL (clear), $4 actor
  setInvoiceKindOverride: `
    UPDATE qbo_invoices
    SET kind_override = $3::text,
        override_by = CASE WHEN $3::text IS NULL THEN NULL ELSE $4::uuid END,
        override_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
    WHERE school = $1 AND qbo_id = $2
    RETURNING qbo_id, kind_auto, kind_override, kind, customer_qbo_id, doc_number, txn_date
  `,

  // Customer picker over the cache. $1 school, $2 ILIKE pattern or NULL, $3 unlinked only,
  // $4 with invoices only, $5/$6 the school year's month window (for the invoice counts).
  searchCustomers: `
    WITH inv AS (
      SELECT customer_qbo_id, count(*)::int AS invoice_count, SUM(total_amt) AS invoice_total, SUM(balance) AS open_balance,
             MIN(txn_date)::text AS earliest_invoice_date
      FROM qbo_invoices
      WHERE school = $1 AND deleted_at IS NULL AND NOT is_voided AND txn_date >= $5::date AND txn_date <= $6::date
      GROUP BY customer_qbo_id
    ),
    linked AS (
      SELECT l.qbo_customer_id, f.family_id, f.name
      FROM family_customer_links l JOIN families f ON f.family_id = l.family_id
      WHERE l.school = $1 AND l.school_year_id = $7 AND l.effective_to IS NULL
    )
    SELECT c.qbo_id, c.display_name, c.fully_qualified_name, c.is_sub_customer, c.parent_qbo_id, c.active, c.emails,
           linked.family_id AS linked_family_id, linked.name AS linked_family_name,
           COALESCE(inv.invoice_count, 0) AS invoice_count, COALESCE(inv.invoice_total, 0) AS invoice_total, COALESCE(inv.open_balance, 0) AS open_balance,
           inv.earliest_invoice_date
    FROM qbo_customers c
    LEFT JOIN linked ON linked.qbo_customer_id = c.qbo_id
    LEFT JOIN inv ON inv.customer_qbo_id = c.qbo_id
    WHERE c.school = $1 AND c.deleted_at IS NULL
      AND ($2::text IS NULL OR c.display_name ILIKE $2 OR EXISTS (SELECT 1 FROM unnest(c.emails) e WHERE e ILIKE $2))
      AND (NOT $3::boolean OR linked.family_id IS NULL)
      AND (NOT $4::boolean OR inv.invoice_count > 0)
    ORDER BY c.display_name
    LIMIT 200
  `,

  // Active students of the year with no family, plus the guardian emails used to suggest one.
  selectStudentsWithoutFamily: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.mother_email, s.father_email
    FROM students s
    LEFT JOIN family_students fs ON fs.student_id = s.student_id
    WHERE s.school = $1 AND s.school_year_id = $2 AND s.is_archived = false AND fs.student_id IS NULL
    ORDER BY s.name
  `,
};

module.exports = financeQueries;
