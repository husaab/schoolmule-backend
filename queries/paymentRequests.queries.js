// queries/paymentRequests.queries.js
//
// SQL for payment requests (services/payments/requests.js). Scoped by school
// and Stripe mode, like the rest of the ledger.

const { CHARGE_COLUMNS, CHARGE_JOINS, CHARGE_EXTRAS, CHARGE_STATS } = require('./charges.queries');

const REQUEST_COLUMNS = `
  r.request_id, r.school, r.livemode, r.school_year_id, r.title, r.description, r.currency, r.amount_cents,
  r.due_date, to_char(r.due_date, 'YYYY-MM-DD') AS due_date_text, r.allow_offline, r.accounting_code,
  r.created_by, r.created_at, r.updated_at,
  (SELECT NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') FROM users u WHERE u.user_id = r.created_by) AS created_by_name
`;

const STATS = CHARGE_STATS;

const paymentRequestsQueries = {
  /** The students a request goes to: picked ones, whole grades, whole classes. Never archived or deleted. */
  selectTargetStudents: `
    SELECT DISTINCT s.student_id
    FROM students s
    WHERE s.school = $1
      AND ($2::uuid IS NULL OR s.school_year_id = $2)
      AND COALESCE(s.is_archived, false) = false
      AND (
        s.student_id = ANY($3::uuid[])
        OR s.grade::text = ANY($4::text[])
        OR s.student_id IN (
          SELECT cs.student_id FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
          WHERE cl.class_id = ANY($5::uuid[]) AND cl.school = $1
        )
      )
  `,

  insertRequest: `
    INSERT INTO payment_requests (school, livemode, school_year_id, title, description, amount_cents, due_date,
                                  allow_offline, accounting_code, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)
    RETURNING *
  `,

  selectRequest: `
    SELECT ${REQUEST_COLUMNS} FROM payment_requests r
    WHERE r.request_id = $1 AND r.school = $2 AND r.livemode = $3
  `,

  selectRequestForUpdate: `
    SELECT ${REQUEST_COLUMNS} FROM payment_requests r
    WHERE r.request_id = $1 AND r.school = $2 AND r.livemode = $3
    FOR UPDATE OF r
  `,

  listRequests: `
    SELECT ${REQUEST_COLUMNS}, stats.*
    FROM payment_requests r
    CROSS JOIN LATERAL (SELECT ${STATS} FROM charges c WHERE c.request_id = r.request_id) stats
    WHERE r.school = $1 AND r.livemode = $2
    ORDER BY r.created_at DESC
    LIMIT 200
  `,

  requestStats: `
    SELECT ${STATS} FROM charges c WHERE c.request_id = $1
  `,

  /** Each family's charge on a request, the ones still owing first. */
  selectRequestCharges: `
    SELECT ${CHARGE_COLUMNS}, ${CHARGE_EXTRAS},
      (SELECT jsonb_build_object('kind', p.kind, 'cardBrand', p.card_brand, 'cardLast4', p.card_last4, 'wallet', p.wallet)
         FROM charge_payments p
        WHERE p.charge_id = c.charge_id AND p.kind IN ('card','cash','cheque','other') AND p.status = 'succeeded'
        ORDER BY p.created_at DESC LIMIT 1) AS last_payment
    FROM charges c ${CHARGE_JOINS}
    WHERE c.request_id = $1
    ORDER BY (c.status IN ('unpaid','partially_paid')) DESC, st.grade, st.name, c.created_at
  `,

  selectOpenRequestCharges: `
    SELECT ${CHARGE_COLUMNS} FROM charges c
    WHERE c.request_id = $1 AND c.status IN ('unpaid','partially_paid')
  `,

  /** Unpaid request charges due within three days ($2 is today, school time) that weren't reminded yet. */
  selectDueSoonCharges: `
    SELECT ${CHARGE_COLUMNS} FROM charges c
    JOIN payment_requests r ON r.request_id = c.request_id
    WHERE c.livemode = $1 AND c.status IN ('unpaid','partially_paid') AND c.reminder_sent_at IS NULL
      AND r.due_date IS NOT NULL AND r.due_date >= $2::date AND r.due_date <= $2::date + 3
    LIMIT 500
  `,

  /** Any money or waiver ever recorded on the request (voided entries count: they are history). */
  countRequestPayments: `
    SELECT COUNT(*)::int AS n FROM charge_payments p JOIN charges c ON c.charge_id = p.charge_id
    WHERE c.request_id = $1
  `,

  updateRequest: `
    UPDATE payment_requests
    SET title = $2, description = $3, amount_cents = $4, due_date = $5::date, allow_offline = $6,
        accounting_code = $7, updated_at = now()
    WHERE request_id = $1
  `,

  updateRequestCharges: `
    UPDATE charges SET description = $2, amount_cents = $3, accounting_code = $4, updated_at = now()
    WHERE request_id = $1
  `,

  updateRequestLines: `
    UPDATE charge_lines l SET label = $2, amount_cents = $3
    FROM charges c WHERE c.charge_id = l.charge_id AND c.request_id = $1
  `,

  renameRequestLines: `
    UPDATE charge_lines l SET label = $2
    FROM charges c WHERE c.charge_id = l.charge_id AND c.request_id = $1
  `,

  // ─── Who to send to ───────────────────────────────────────────────

  rosterStudents: `
    SELECT s.student_id, s.name, s.grade::text AS grade,
      ARRAY(SELECT cs.class_id FROM class_students cs WHERE cs.student_id = s.student_id) AS class_ids
    FROM students s
    WHERE s.school = $1 AND ($2::uuid IS NULL OR s.school_year_id = $2) AND COALESCE(s.is_archived, false) = false
  `,

  rosterClasses: `
    SELECT cl.class_id, cl.subject, cl.grade::text AS grade, cl.teacher_name,
      (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = cl.class_id)::int AS student_count
    FROM classes cl
    WHERE cl.school = $1 AND ($2::uuid IS NULL OR cl.school_year_id = $2)
  `,
};

module.exports = paymentRequestsQueries;
