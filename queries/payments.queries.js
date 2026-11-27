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

  selectAccountByStripeId: `
    SELECT ${ACCOUNT_COLUMNS}
    FROM payment_accounts
    WHERE stripe_account_id = $1 AND livemode = $2
  `,

  /** Every school still connected in this mode, for the nightly re-check. */
  selectAccountsToRefresh: `
    SELECT ${ACCOUNT_COLUMNS}
    FROM payment_accounts
    WHERE livemode = $1 AND status <> 'disconnected'
    ORDER BY connected_at
  `,

  /** The school cut the link from its own Stripe Dashboard. */
  markAccountDeauthorized: `
    UPDATE payment_accounts
    SET status = 'disconnected', disconnected_at = now(), updated_at = now(),
        last_error = 'The school disconnected SchoolMule from its Stripe account'
    WHERE payment_account_id = $1 AND status <> 'disconnected'
    RETURNING ${ACCOUNT_COLUMNS}
  `,

  // ─── Stripe events: the webhook's inbox and the worker's queue ────────

  /** A repeat delivery of the same event is dropped here. */
  insertEvent: `
    INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id, stripe_created_at)
    VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `,

  /** One due event of this mode, or one whose worker died mid-flight (5 minutes). */
  claimNextEvent: `
    UPDATE stripe_events
    SET state = 'running', attempts = attempts + 1, claimed_at = now()
    WHERE event_id = (
      SELECT event_id FROM stripe_events
      WHERE livemode = $1
        AND ((state = 'queued' AND next_attempt_at <= now())
          OR (state = 'running' AND claimed_at < now() - interval '5 minutes'))
      ORDER BY received_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `,

  completeEvent: `
    UPDATE stripe_events
    SET state = 'done', processed_at = now(), last_error = NULL
    WHERE event_id = $1
  `,

  // Requeue with exponential backoff, or give up once attempts reach the cap ($3).
  failEvent: `
    UPDATE stripe_events
    SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
        last_error = $2,
        next_attempt_at = now() + (interval '1 second' * power(4, attempts))
    WHERE event_id = $1
    RETURNING state
  `,

  failEventPermanently: `
    UPDATE stripe_events
    SET state = 'failed', last_error = $2
    WHERE event_id = $1
  `,

  /** Handled events are only kept long enough to explain a recent problem. */
  purgeOldEvents: `
    DELETE FROM stripe_events
    WHERE livemode = $1 AND state = 'done' AND processed_at < now() - interval '30 days'
  `,
};

module.exports = paymentsQueries;
