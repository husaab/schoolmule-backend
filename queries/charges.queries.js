// queries/charges.queries.js
//
// SQL for the payments ledger: charges, their lines and their payments.
// Staff reads are scoped by school and Stripe mode; the family's own link is
// scoped by the charge's secret token.

const CHARGE_COLUMNS = `
  c.charge_id, c.school, c.livemode, c.source_type, c.submission_id, c.form_id, c.field_id, c.student_id,
  c.payer_email, c.description, c.currency, c.amount_cents, c.amount_paid_cents, c.amount_refunded_cents,
  c.status, c.chosen_method, c.paid_at, c.accounting_code, c.public_token, c.payment_account_id,
  c.checkout_session_id, c.checkout_url, c.checkout_expires_at, c.checkout_attempts,
  c.reminder_sent_at, c.link_sent_at, c.dispute_status, c.created_at, c.updated_at
`;

const PAYMENT_COLUMNS = `
  p.payment_id, p.charge_id, p.school, p.kind, p.amount_cents, p.status, p.stripe_checkout_session_id,
  p.stripe_payment_intent_id, p.stripe_charge_id, p.stripe_refund_id, p.card_brand, p.card_last4, p.wallet,
  p.stripe_fee_cents, p.note, p.recorded_by, p.created_at, p.voided_at, p.voided_by,
  (SELECT NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') FROM users u WHERE u.user_id = p.recorded_by) AS recorded_by_name
`;

const chargesQueries = {
  CHARGE_COLUMNS,

  insertCharge: `
    INSERT INTO charges (school, livemode, submission_id, form_id, field_id, student_id, payer_email, description,
                         currency, amount_cents, chosen_method, accounting_code, payment_account_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
  `,

  insertLine: `
    INSERT INTO charge_lines (charge_id, item_id, label, amount_cents, sort_order)
    VALUES ($1, $2, $3, $4, $5)
  `,

  selectChargeById: `
    SELECT ${CHARGE_COLUMNS}, f.title AS form_title, f.slug AS form_slug
    FROM charges c LEFT JOIN registration_forms f ON f.form_id = c.form_id
    WHERE c.charge_id = $1 AND c.school = $2 AND c.livemode = $3
  `,

  /** The family's link. Any Stripe mode: the token itself is the secret. */
  selectChargeByToken: `
    SELECT ${CHARGE_COLUMNS}, f.title AS form_title, f.slug AS form_slug, s.name AS school_name, s.slug AS school_slug
    FROM charges c
    LEFT JOIN registration_forms f ON f.form_id = c.form_id
    LEFT JOIN schools s ON s.school_code = c.school
    WHERE c.public_token = $1
  `,

  /** For the worker: the charge a Stripe object names, in this mode. */
  selectChargeForStripe: `
    SELECT ${CHARGE_COLUMNS}
    FROM charges c
    WHERE c.charge_id = $1 AND c.livemode = $2
  `,

  selectChargeBySession: `
    SELECT ${CHARGE_COLUMNS}
    FROM charges c
    WHERE c.checkout_session_id = $1 AND c.livemode = $2
  `,

  /** The charge a card payment belongs to, found from Stripe's payment id. */
  selectChargeByPaymentIntent: `
    SELECT ${CHARGE_COLUMNS}
    FROM charges c
    JOIN charge_payments p ON p.charge_id = c.charge_id
    WHERE p.stripe_payment_intent_id = $1 AND c.livemode = $2
    LIMIT 1
  `,

  selectChargeForUpdate: `
    SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.charge_id = $1 FOR UPDATE
  `,

  selectLines: `
    SELECT line_id, item_id, label, amount_cents, sort_order
    FROM charge_lines WHERE charge_id = $1 ORDER BY sort_order, label
  `,

  selectPayments: `
    SELECT ${PAYMENT_COLUMNS}
    FROM charge_payments p WHERE p.charge_id = $1 ORDER BY p.created_at, p.payment_id
  `,

  selectPaymentById: `
    SELECT ${PAYMENT_COLUMNS}
    FROM charge_payments p WHERE p.payment_id = $1 AND p.charge_id = $2
  `,

  updateChargeTotals: `
    UPDATE charges
    SET status = $2::varchar, amount_paid_cents = $3, amount_refunded_cents = $4, paid_at = $5, updated_at = now()
    WHERE charge_id = $1
    RETURNING *
  `,

  setCheckout: `
    UPDATE charges
    SET checkout_session_id = $2, checkout_url = $3, checkout_expires_at = to_timestamp($4),
        checkout_attempts = checkout_attempts + 1, updated_at = now()
    WHERE charge_id = $1
    RETURNING *
  `,

  clearCheckout: `
    UPDATE charges
    SET checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL, updated_at = now()
    WHERE charge_id = $1 AND checkout_session_id = $2
  `,

  /** Only the first caller gets a row back, so the automatic reminder goes once. */
  claimReminder: `
    UPDATE charges SET reminder_sent_at = now(), updated_at = now()
    WHERE charge_id = $1 AND reminder_sent_at IS NULL
    RETURNING charge_id
  `,

  markLinkSent: `
    UPDATE charges SET link_sent_at = now(), updated_at = now() WHERE charge_id = $1
  `,

  setDispute: `
    UPDATE charges SET dispute_status = $2, updated_at = now() WHERE charge_id = $1
  `,

  /** A repeated webhook and the family's return page can both get here: the session id keeps it to one. */
  insertCardPayment: `
    INSERT INTO charge_payments (charge_id, school, kind, amount_cents, status, stripe_checkout_session_id,
                                 stripe_payment_intent_id, stripe_charge_id, card_brand, card_last4, wallet, stripe_fee_cents)
    VALUES ($1, $2, 'card', $3, 'succeeded', $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (stripe_checkout_session_id) DO NOTHING
    RETURNING payment_id
  `,

  insertOfflinePayment: `
    INSERT INTO charge_payments (charge_id, school, kind, amount_cents, status, note, recorded_by)
    VALUES ($1, $2, $3, $4, 'succeeded', $5, $6)
    RETURNING payment_id
  `,

  /** One row per Stripe refund; a later webhook updates its status. */
  upsertRefund: `
    INSERT INTO charge_payments (charge_id, school, kind, amount_cents, status, stripe_refund_id,
                                 stripe_payment_intent_id, stripe_charge_id, note, recorded_by)
    VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (stripe_refund_id) DO UPDATE
      SET status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents
    RETURNING payment_id, (xmax = 0) AS inserted
  `,

  voidPayment: `
    UPDATE charge_payments
    SET status = 'voided', voided_at = now(), voided_by = $3
    WHERE payment_id = $1 AND charge_id = $2 AND status = 'succeeded' AND kind IN ('cash','cheque','other','waiver')
    RETURNING payment_id
  `,

  /** Nothing has happened to it yet: no payment of any kind, voided or not. */
  countPayments: `
    SELECT COUNT(*)::int AS n FROM charge_payments WHERE charge_id = $1
  `,

  deleteCharge: `
    DELETE FROM charges WHERE charge_id = $1
  `,

  selectChargeForSubmission: `
    SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.submission_id = $1
  `,

  countChargesForForm: `
    SELECT COUNT(*)::int AS n FROM charges WHERE form_id = $1
  `,

  // ─── Staff lists ──────────────────────────────────────────────────

  /** One page of the school's charges, newest first. $4 status filter, $5 form, $6 search. */
  listCharges: `
    SELECT ${CHARGE_COLUMNS}, f.title AS form_title,
      (SELECT jsonb_build_object('kind', p.kind, 'cardBrand', p.card_brand, 'cardLast4', p.card_last4, 'wallet', p.wallet)
         FROM charge_payments p
        WHERE p.charge_id = c.charge_id AND p.kind IN ('card','cash','cheque','other') AND p.status = 'succeeded'
        ORDER BY p.created_at DESC LIMIT 1) AS last_payment,
      (SELECT COALESCE(SUM(p.stripe_fee_cents), 0) FROM charge_payments p
        WHERE p.charge_id = c.charge_id AND p.kind = 'card' AND p.status = 'succeeded') AS stripe_fee_cents,
      COUNT(*) OVER() AS total_count
    FROM charges c
    LEFT JOIN registration_forms f ON f.form_id = c.form_id
    WHERE c.school = $1 AND c.livemode = $2
      AND ($4::text IS NULL OR c.status = $4 OR ($4 = 'open' AND c.status IN ('unpaid','partially_paid')))
      AND ($5::uuid IS NULL OR c.form_id = $5)
      AND ($6::text IS NULL OR c.payer_email ILIKE '%' || $6 || '%' OR f.title ILIKE '%' || $6 || '%' OR c.description ILIKE '%' || $6 || '%')
    ORDER BY c.created_at DESC, c.charge_id
    LIMIT $3 OFFSET $7
  `,

  /** The tiles on the Payments page. $3 is the start of this month (school time). */
  summary: `
    SELECT
      COALESCE((SELECT SUM(p.amount_cents) FROM charge_payments p JOIN charges c ON c.charge_id = p.charge_id
                 WHERE c.school = $1 AND c.livemode = $2 AND p.kind IN ('card','cash','cheque','other')
                   AND p.status = 'succeeded' AND p.created_at >= $3), 0)::int AS collected_this_month_cents,
      COALESCE((SELECT SUM(p.amount_cents) FROM charge_payments p JOIN charges c ON c.charge_id = p.charge_id
                 WHERE c.school = $1 AND c.livemode = $2 AND p.kind = 'refund'
                   AND p.status IN ('succeeded','pending') AND p.created_at >= $3), 0)::int AS refunded_this_month_cents,
      COALESCE((SELECT SUM(GREATEST(c.amount_cents - c.amount_paid_cents, 0)) FROM charges c
                 WHERE c.school = $1 AND c.livemode = $2 AND c.status IN ('unpaid','partially_paid')), 0)::int AS outstanding_cents,
      (SELECT COUNT(*) FROM charges c
        WHERE c.school = $1 AND c.livemode = $2 AND c.status IN ('unpaid','partially_paid'))::int AS outstanding_count,
      (SELECT COUNT(*) FROM charges c
        WHERE c.school = $1 AND c.livemode = $2 AND c.dispute_status IS NOT NULL
          AND c.dispute_status NOT IN ('won','lost','closed'))::int AS open_disputes
  `,

  /** Charges that left Stripe's page without paying, for the safety-net check. */
  selectStaleCheckouts: `
    SELECT ${CHARGE_COLUMNS}, a.stripe_account_id
    FROM charges c
    JOIN payment_accounts a ON a.payment_account_id = c.payment_account_id
    WHERE c.livemode = $1 AND c.checkout_session_id IS NOT NULL
      AND c.status IN ('unpaid','partially_paid')
      AND c.updated_at < now() - interval '10 minutes'
    ORDER BY c.updated_at
    LIMIT 50
  `,
};

module.exports = chargesQueries;
