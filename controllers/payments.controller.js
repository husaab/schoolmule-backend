// controllers/payments.controller.js
//
// HTTP surface for Finance → Payments: the school's Stripe connection, the
// overview, the ledger (every charge, from forms and payment requests) with
// the office's actions, payment requests, and payouts. Everything here needs
// the `finance` permission (routes/payments.routes.js).

const ExcelJS = require('exceljs');
const db = require('../config/database');
const logger = require('../logger');
const connect = require('../services/payments/connect');
const charges = require('../services/payments/charges');
const requests = require('../services/payments/requests');
const chargeQueries = require('../queries/charges.queries');
const { formatCents } = require('../services/payments/paymentField');
const { paidWith } = require('../services/payments/emails');
const stripeClient = require('../services/payments/stripeClient');
const { StripeApiError, StripeConfigError } = require('../services/payments/errors');

const fail = (res, status, message) => res.status(status).json({ status: 'failed', message });
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

const toAccount = (row) => (row ? {
  connected: row.status !== 'disconnected',
  status: row.status,
  canTakePayments: row.status === 'active',
  stripeAccountId: row.stripe_account_id,
  livemode: row.livemode,
  cardPaymentsStatus: row.card_payments_status,
  payoutsStatus: row.payouts_status,
  requirementsDue: row.requirements_due,
  requirementsPastDue: row.requirements_past_due,
  displayName: row.display_name,
  currency: row.default_currency,
  activatedAt: row.activated_at,
  lastSyncedAt: row.last_synced_at,
  // last_error holds Stripe's own words; it stays on the server (and in the log).
  syncFailed: Boolean(row.last_error),
  connectedAt: row.connected_at,
  disconnectedAt: row.disconnected_at,
} : null);

/** One answer for every way a Stripe call can fail, with the detail kept in the log. */
function failStripe(res, error, action) {
  if (error instanceof StripeConfigError) {
    logger.error({ err: error }, `Payments: ${action} refused, Stripe is not configured`);
    return fail(res, 503, 'Payments are not set up on this server yet');
  }
  if (error instanceof StripeApiError) {
    logger.error({ err: error, stripeCode: error.code, stripeStatus: error.status }, `Payments: Stripe call failed (${action})`);
    return fail(res, 502, 'Stripe could not complete that. Please try again in a moment.');
  }
  if (error instanceof charges.ChargeError) {
    return res.status(error.status).json({ status: 'failed', code: error.code, message: error.message });
  }
  if (error.status === 404) return fail(res, 404, error.message);
  logger.error({ err: error }, `Payments: error (${action})`);
  return fail(res, 500, 'Something went wrong with payments');
}

/** The school's connection, without calling Stripe. `configured` is false until the server has a key. */
const getAccount = async (req, res) => {
  let client;
  try {
    client = stripeClient.clientFromEnv();
  } catch (error) {
    if (error instanceof StripeConfigError) return ok(res, { configured: false, mode: null, account: null });
    return failStripe(res, error, 'load account');
  }
  try {
    const row = await connect.findAccount(req.user.school, client.livemode);
    return ok(res, { configured: true, mode: client.mode, account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'load account');
  }
};

/** A single-use link to Stripe's hosted sign-up; opens the school's account the first time. */
const createOnboardingLink = async (req, res) => {
  try {
    const { url, account } = await connect.startOnboarding({ school: req.user.school, user: req.user });
    logger.info({ school: req.user.school, userId: req.user.userId, stripeAccountId: account.stripe_account_id }, 'Payments: Stripe onboarding link created');
    return ok(res, { url, account: toAccount(account) }, 201);
  } catch (error) {
    return failStripe(res, error, 'create onboarding link');
  }
};

/** Re-reads the school's account from Stripe, for the moment it comes back from the sign-up. */
const syncAccount = async (req, res) => {
  try {
    const row = await connect.syncAccount({ school: req.user.school });
    if (!row) return fail(res, 404, 'Stripe is not connected');
    return ok(res, { account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'sync account');
  }
};

const disconnect = async (req, res) => {
  try {
    const row = await connect.disconnect({ school: req.user.school });
    if (!row) return fail(res, 404, 'Stripe is not connected');
    logger.info({ school: req.user.school, userId: req.user.userId, stripeAccountId: row.stripe_account_id }, 'Payments: Stripe disconnected');
    return ok(res, { account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'disconnect');
  }
};

// ─── The ledger ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['open', 'unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'waived']);

/** The Stripe mode this server works in; without a key, only the test-mode (offline) ledger. */
const livemodeOf = () => {
  const client = charges.clientOrNull();
  return client ? client.livemode : false;
};

/** Midnight on the first of this month, school time (every school is in Toronto today). */
function monthStart() {
  const now = new Date();
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).split('-');
  // Toronto is UTC-5 or UTC-4; asking Postgres would be exact, but a few hours either side of midnight on the 1st is fine for a tile.
  return new Date(`${y}-${m}-01T05:00:00Z`);
}

const getSummary = async (req, res) => {
  try {
    const { rows: [row] } = await db.query(chargeQueries.summary, [req.user.school, livemodeOf(), monthStart()]);
    return ok(res, {
      collectedThisMonthCents: row.collected_this_month_cents,
      refundedThisMonthCents: row.refunded_this_month_cents,
      outstandingCents: row.outstanding_cents,
      outstandingCount: row.outstanding_count,
      openDisputes: row.open_disputes,
    });
  } catch (error) {
    return failStripe(res, error, 'load summary');
  }
};

const SOURCES = { form: 'form_submission', request: 'request' };
const uuidOrNull = (value) => (UUID_RE.test(String(value || '')) ? value : null);

function listParams(query) {
  const status = STATUSES.has(query.status) ? query.status : null;
  const formId = uuidOrNull(query.formId);
  const requestId = uuidOrNull(query.requestId);
  const studentId = uuidOrNull(query.studentId);
  const source = SOURCES[query.source] || null;
  const search = String(query.q || '').trim().slice(0, 80) || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { status, formId, requestId, studentId, source, search, limit, page };
}

/** The listCharges parameters, in order. */
const listArgs = (school, p, limit, offset) => [school, livemodeOf(), limit, p.status, p.formId, p.search, offset, p.requestId, p.source, p.studentId];

const listCharges = async (req, res) => {
  try {
    const params = listParams(req.query);
    const { limit, page } = params;
    const { rows } = await db.query(chargeQueries.listCharges, listArgs(req.user.school, params, limit, (page - 1) * limit));
    return res.status(200).json({
      status: 'success',
      data: rows.map((row) => charges.toCharge(row, { finance: true })),
      pagination: { total: rows[0] ? Number(rows[0].total_count) : 0, page, limit },
    });
  } catch (error) {
    return failStripe(res, error, 'list payments');
  }
};

const STATUS_LABELS = {
  unpaid: 'Unpaid', partially_paid: 'Part paid', paid: 'Paid', partially_refunded: 'Part refunded', refunded: 'Refunded', waived: 'Waived',
};

const exportCharges = async (req, res) => {
  try {
    const { rows } = await db.query(chargeQueries.listCharges, listArgs(req.user.school, listParams(req.query), 10000, 0));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payments');
    sheet.addRow(['Date', 'For', 'Student', 'Grade', 'Email', 'Status', 'Amount', 'Paid', 'Refunded', 'Still owed', 'Stripe fee', 'Paid with', 'Due', 'Accounting code', 'Reference']);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      const c = charges.toCharge(row, { finance: true });
      const last = row.last_payment;
      sheet.addRow([
        new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }),
        row.form_title || row.request_title || row.description,
        row.student_name || '',
        row.student_grade || '',
        row.payer_email || '',
        STATUS_LABELS[row.status] || row.status,
        formatCents(c.amountCents),
        formatCents(c.amountPaidCents),
        c.amountRefundedCents ? formatCents(c.amountRefundedCents) : '',
        c.balanceCents ? formatCents(c.balanceCents) : '',
        c.stripeFeeCents ? formatCents(c.stripeFeeCents) : '',
        last ? paidWith({ kind: last.kind, card_brand: last.cardBrand, card_last4: last.cardLast4, wallet: last.wallet }) : '',
        row.due_date || '',
        row.accounting_code || '',
        String(row.charge_id).slice(0, 8).toUpperCase(),
      ]);
    }
    sheet.columns.forEach((col) => { col.width = 16; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Payments.csv"');
    await workbook.csv.write(res);
  } catch (error) {
    logger.error({ err: error }, 'Payments: export failed');
    if (!res.headersSent) fail(res, 500, 'Error exporting payments');
  }
};

const getCharge = async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.chargeId)) return fail(res, 404, 'Payment not found');
    const charge = await charges.detailForStaff({ school: req.user.school, livemode: livemodeOf(), chargeId: req.params.chargeId, finance: true });
    if (!charge) return fail(res, 404, 'Payment not found');
    return ok(res, charge);
  } catch (error) {
    return failStripe(res, error, 'load payment');
  }
};

/** Runs an office action on a charge and answers with the charge as it now stands. */
const action = (name, run) => async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.chargeId)) return fail(res, 404, 'Payment not found');
    const base = { school: req.user.school, livemode: livemodeOf(), chargeId: req.params.chargeId, user: req.user };
    await run(base, req.body || {}, req);
    const charge = await charges.detailForStaff({ ...base, finance: true });
    logger.info({ school: req.user.school, userId: req.user.userId, chargeId: req.params.chargeId, action: name }, `Payments: ${name}`);
    return ok(res, charge);
  } catch (error) {
    return failStripe(res, error, name);
  }
};

const recordOffline = action('offline payment recorded', (base, body) => charges.recordOffline({
  ...base, kind: body.kind, amountCents: body.amountCents ?? null, note: body.note, sendReceipt: body.sendReceipt !== false,
}));

const waive = action('fee waived', (base, body) => charges.waive({ ...base, note: body.note }));

const voidPayment = action('payment removed', (base, body, req) => {
  if (!UUID_RE.test(req.params.paymentId)) throw new charges.ChargeError('Payment not found', 404);
  return charges.voidPayment({ ...base, paymentId: req.params.paymentId });
});

const refund = action('refund issued', (base, body) => charges.refund({ ...base, amountCents: body.amountCents ?? null, note: body.note }));

const sendLink = action('payment link sent', (base) => charges.sendPaymentLink(base));

const setStudent = action('student linked', (base, body) => {
  const studentId = body.studentId == null || body.studentId === '' ? null : body.studentId;
  if (studentId !== null && !UUID_RE.test(String(studentId))) throw new charges.ChargeError('Student not found', 404);
  return charges.setStudent({ ...base, studentId });
});

/** Students matching a name (?q=), to link a payment to a child. */
const searchStudents = async (req, res) => {
  try {
    const students = await charges.searchStudents({
      school: req.user.school, schoolYearId: req.schoolYear?.schoolYearId ?? null, search: req.query.q,
    });
    return ok(res, students);
  } catch (error) {
    return failStripe(res, error, 'search students');
  }
};

// ─── The overview ─────────────────────────────────────────────────────

const MONTHS_SHOWN = 6;

/** The last six months, oldest first ("2026-06" … "2026-11"), and when the first one starts. */
function recentMonths(now = new Date()) {
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).split('-').map(Number);
  const months = [];
  for (let i = MONTHS_SHOWN - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  // Midnight Toronto is 04:00 or 05:00 UTC; starting at 04:00 counts nothing from the month before that matters for a chart.
  const [fy, fm] = months[0].split('-').map(Number);
  return { months, from: new Date(Date.UTC(fy, fm - 1, 1, 4)) };
}

const toStats = (row) => ({
  count: row.students_count,
  settled: row.settled_count,
  open: row.open_count,
  expectedCents: Number(row.expected_cents) || 0,
  collectedCents: Number(row.collected_cents) || 0,
  outstandingCents: Number(row.outstanding_cents) || 0,
  waivedCents: Number(row.waived_cents) || 0,
});

/**
 * GET /api/payments/overview: one call for the Overview tab. The tiles, money
 * in per month, every form and request with how far along it is, and the
 * latest activity.
 */
const getOverview = async (req, res) => {
  try {
    const school = req.user.school;
    const livemode = livemodeOf();
    const { months, from } = recentMonths();
    const [{ rows: [summary] }, { rows: monthRows }, { rows: formRows }, requestList, { rows: activity }] = await Promise.all([
      db.query(chargeQueries.summary, [school, livemode, monthStart()]),
      db.query(chargeQueries.overviewMonths, [school, livemode, from]),
      db.query(chargeQueries.overviewForms, [school, livemode]),
      requests.list({ school, livemode }),
      db.query(chargeQueries.overviewActivity, [school, livemode]),
    ]);
    const byMonth = new Map(monthRows.map((r) => [r.month, r]));
    return ok(res, {
      summary: {
        collectedThisMonthCents: summary.collected_this_month_cents,
        refundedThisMonthCents: summary.refunded_this_month_cents,
        outstandingCents: summary.outstanding_cents,
        outstandingCount: summary.outstanding_count,
        openDisputes: summary.open_disputes,
      },
      months: months.map((month) => {
        const r = byMonth.get(month) || {};
        return {
          month,
          cardCents: r.card_cents || 0,
          officeCents: r.office_cents || 0,
          refundedCents: r.refunded_cents || 0,
          stripeFeeCents: r.stripe_fee_cents || 0,
        };
      }),
      collections: [
        ...requestList.map((r) => ({
          source: 'request', id: r.requestId, title: r.title, dueDate: r.dueDate, createdAt: r.createdAt,
          stats: { count: r.stats.students, settled: r.stats.settled, open: r.stats.open, expectedCents: r.stats.expectedCents, collectedCents: r.stats.collectedCents, outstandingCents: r.stats.outstandingCents, waivedCents: r.stats.waivedCents },
        })),
        ...formRows.map((r) => ({
          source: 'form', id: r.form_id, title: r.title, slug: r.slug, dueDate: null, createdAt: r.last_at, stats: toStats(r),
        })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12),
      activity: activity.map((a) => ({
        paymentId: a.payment_id,
        chargeId: a.charge_id,
        kind: a.kind,
        status: a.status,
        amountCents: a.amount_cents,
        createdAt: a.created_at,
        title: a.form_title || a.request_title || a.description,
        sourceType: a.source_type,
        studentName: a.student_name,
        payerEmail: a.payer_email,
        paidWith: ['card', 'cash', 'cheque', 'other'].includes(a.kind) ? paidWith(a) : null,
      })),
    });
  } catch (error) {
    return failStripe(res, error, 'load overview');
  }
};

// ─── Payment requests ─────────────────────────────────────────────────

const base = (req) => ({ school: req.user.school, livemode: livemodeOf(), user: req.user, schoolYearId: req.schoolYear?.schoolYearId ?? null });

const listRequests = async (req, res) => {
  try {
    return ok(res, await requests.list(base(req)));
  } catch (error) {
    return failStripe(res, error, 'list requests');
  }
};

const getRequest = async (req, res) => {
  try {
    return ok(res, await requests.detail({ ...base(req), requestId: req.params.requestId }));
  } catch (error) {
    return failStripe(res, error, 'load request');
  }
};

/** The students and classes of the year, for choosing who a request goes to. */
const getRoster = async (req, res) => {
  try {
    return ok(res, await requests.roster(base(req)));
  } catch (error) {
    return failStripe(res, error, 'load roster');
  }
};

const createRequest = async (req, res) => {
  try {
    const made = await requests.create({ ...base(req), body: req.body || {} });
    return ok(res, await requests.detail({ ...base(req), requestId: made.requestId }), 201);
  } catch (error) {
    return failStripe(res, error, 'create request');
  }
};

/** Runs a request action and answers with the request as it now stands. */
const requestAction = (name, run) => async (req, res) => {
  try {
    const result = await run({ ...base(req), requestId: req.params.requestId }, req.body || {}, req);
    logger.info({ school: req.user.school, userId: req.user.userId, requestId: req.params.requestId, action: name }, `Payments: ${name}`);
    const request = await requests.detail({ ...base(req), requestId: req.params.requestId });
    return ok(res, { ...request, result });
  } catch (error) {
    return failStripe(res, error, name);
  }
};

const updateRequest = requestAction('request edited', (b, body) => requests.update({ ...b, body }));
const addRequestStudents = requestAction('students added to request', (b, body) => requests.addStudents({ ...b, body }));
const remindRequest = requestAction('request reminders sent', (b) => requests.remind(b));
const removeRequestCharge = requestAction('student removed from request', (b, body, req) => {
  if (!UUID_RE.test(req.params.chargeId)) throw new charges.ChargeError('That student isn’t on this request.', 404);
  return requests.removeCharge({ ...b, chargeId: req.params.chargeId });
});

const deleteRequest = async (req, res) => {
  try {
    await requests.remove({ ...base(req), requestId: req.params.requestId });
    logger.info({ school: req.user.school, userId: req.user.userId, requestId: req.params.requestId }, 'Payments: request deleted');
    return ok(res, { deleted: true });
  } catch (error) {
    return failStripe(res, error, 'delete request');
  }
};

/** The school's payouts to its bank, straight from Stripe. */
const listPayouts = async (req, res) => {
  try {
    const client = stripeClient.clientFromEnv();
    const row = await connect.findAccount(req.user.school, client.livemode);
    if (!row || row.status === 'disconnected') return ok(res, { payouts: [], balance: null });
    const [payouts, balance] = await Promise.all([
      client.listPayouts(row.stripe_account_id, { limit: 20 }),
      client.retrieveBalance(row.stripe_account_id).catch(() => null),
    ]);
    const sum = (list) => (list || []).filter((b) => b.currency === 'cad').reduce((s, b) => s + b.amount, 0);
    return ok(res, {
      payouts: (payouts.data || []).map((p) => ({
        payoutId: p.id,
        amountCents: p.amount,
        currency: p.currency,
        status: p.status,
        arrivalDate: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        createdAt: p.created ? new Date(p.created * 1000).toISOString() : null,
        automatic: Boolean(p.automatic),
        failureMessage: p.failure_message || null,
      })),
      balance: balance ? { availableCents: sum(balance.available), pendingCents: sum(balance.pending) } : null,
    });
  } catch (error) {
    return failStripe(res, error, 'list payouts');
  }
};

module.exports = {
  getAccount, createOnboardingLink, syncAccount, disconnect,
  getSummary, listCharges, exportCharges, getCharge, recordOffline, waive, voidPayment, refund, sendLink, listPayouts,
  setStudent, searchStudents, getOverview, recentMonths,
  listRequests, getRequest, getRoster, createRequest, updateRequest, addRequestStudents, remindRequest, removeRequestCharge, deleteRequest,
};
