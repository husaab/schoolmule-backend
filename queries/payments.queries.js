// queries/payments.queries.js
//
// SQL for Payments. Every statement is scoped by school, and by Stripe mode
// (livemode) so a process holding a test key only ever sees test rows.

const ACCOUNT_COLUMNS = `
  payment_account_id, school, livemode, stripe_account_id, status,
  card_payments_status, payouts_status, requirements_due, requirements_past_due,
  display_name, country, default_currency, activated_at, last_synced_at, last_error,
  connected_by, connected_at, disconnected_at, updated_at
`;

const paymentsQueries = {
  selectAccount: `
    SELECT ${ACCOUNT_COLUMNS}
    FROM payment_accounts
    WHERE school = $1 AND livemode = $2
  `,

  /** What Stripe needs to open the school's account. */
  selectSchoolForAccount: `
    SELECT name, email
    FROM schools
    WHERE school_code = $1
  `,

  /** Two people clicking Connect at once must end with one row. */
  insertAccount: `
    INSERT INTO payment_accounts (school, livemode, stripe_account_id, display_name, country, default_currency, connected_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (school, livemode) DO NOTHING
    RETURNING ${ACCOUNT_COLUMNS}
  `,

  /** activated_at is set once, the first time card payments are active. A row
   *  disconnected while Stripe was being asked is left alone (no row returned). */
  updateAccountFromStripe: `
    UPDATE payment_accounts
    SET status = $2::varchar,
        card_payments_status = $3,
        payouts_status = $4,
        requirements_due = $5,
        requirements_past_due = $6,
        display_name = COALESCE($7, display_name),
        activated_at = CASE WHEN $2::varchar = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
        last_synced_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE payment_account_id = $1 AND status <> 'disconnected'
    RETURNING ${ACCOUNT_COLUMNS}
  `,

  setAccountError: `
    UPDATE payment_accounts
    SET last_error = $2, updated_at = now()
    WHERE payment_account_id = $1
  `,

  disconnectAccount: `
    UPDATE payment_accounts
    SET status = 'disconnected', disconnected_at = now(), updated_at = now()
    WHERE school = $1 AND livemode = $2 AND status <> 'disconnected'
    RETURNING ${ACCOUNT_COLUMNS}
  `,

  /** Reconnecting picks the same Stripe account up again. */
  reconnectAccount: `
    UPDATE payment_accounts
    SET status = 'onboarding', disconnected_at = NULL, connected_by = $2, updated_at = now()
    WHERE payment_account_id = $1
    RETURNING ${ACCOUNT_COLUMNS}
  `,
};

module.exports = paymentsQueries;
