// controllers/parentPayments.controller.js
//
// The parent portal's Payments page: what the family owes the school and what
// it has paid, across its children. Each entry opens the family's own payment
// page (/pay/<token>), so paying works exactly as it does from an email.
//
// Switched off until the school is ready: PARENT_PAYMENTS_ENABLED=true turns
// it on. Off, the route answers 404 as if it didn't exist.

const db = require('../config/database');
const logger = require('../logger');
const charges = require('../services/payments/charges');
const { balanceCents, canPayOnline } = require('../services/payments/chargeStatus');
const q = require('../queries/charges.queries');

const enabled = () => process.env.PARENT_PAYMENTS_ENABLED === 'true';

/**
 * A family's charges: those for a child linked to the parent, and those from
 * forms the parent sent while signed in. History goes back a year.
 */
const PARENT_CHARGES = `
  SELECT ${q.CHARGE_COLUMNS}, ${q.CHARGE_EXTRAS}
  FROM charges c ${q.CHARGE_JOINS}
  WHERE c.school = $2 AND c.livemode = $3
    AND (
      c.student_id IN (SELECT ps.student_id FROM parent_students ps WHERE ps.parent_id = $1)
      OR c.submission_id IN (SELECT s.submission_id FROM registration_form_submissions s WHERE s.submitted_by = $1)
    )
    AND (c.status IN ('unpaid','partially_paid') OR c.created_at > now() - interval '12 months')
  ORDER BY (c.status IN ('unpaid','partially_paid')) DESC, r.due_date NULLS LAST, c.created_at DESC
  LIMIT 200
`;

function toEntry(row) {
  const facts = { amountCents: row.amount_cents, amountPaidCents: row.amount_paid_cents, status: row.status };
  return {
    chargeId: row.charge_id,
    title: row.form_title || row.request_title || row.description,
    sourceType: row.source_type,
    studentName: row.student_name || null,
    currency: row.currency,
    amountCents: row.amount_cents,
    amountPaidCents: row.amount_paid_cents,
    amountRefundedCents: row.amount_refunded_cents,
    balanceCents: balanceCents(facts),
    // A waiver is the office's business: the family sees it as settled.
    status: charges.visibleStatus(row.status, false),
    dueDate: row.due_date || null,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    canPayOnline: canPayOnline(facts),
    payPath: `/pay/${row.public_token}`,
  };
}

/** GET /api/parent-portal/payments */
const listPayments = async (req, res) => {
  if (!enabled()) return res.status(404).json({ status: 'failed', code: 'NOT_ENABLED', message: 'Not found' });
  try {
    const client = charges.clientOrNull();
    const livemode = client ? client.livemode : false;
    const { rows } = await db.query(PARENT_CHARGES, [req.user.userId, req.user.school, livemode]);
    const entries = rows.map(toEntry);
    const owing = entries.filter((e) => e.status === 'unpaid' || e.status === 'partially_paid');
    const { online } = await charges.availability(req.user.school, client);
    return res.status(200).json({
      status: 'success',
      data: {
        owing,
        history: entries.filter((e) => !owing.includes(e)),
        totalOwingCents: owing.reduce((sum, e) => sum + e.balanceCents, 0),
        canPayOnline: online,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Parent payments: list failed');
    return res.status(500).json({ status: 'failed', message: 'Error loading payments' });
  }
};

module.exports = { listPayments, enabled };
