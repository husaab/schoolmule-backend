// services/payments/requests.js
//
// Payment requests: the office asks families to pay for something (a trip, a
// book fee) without a form. A request makes one charge per student it is sent
// to, in the same ledger as form payments, and emails the student's guardians
// a link to their own payment page (/pay/<token>).
//
// Rules this module keeps:
//   - A student is asked once per request (a unique index), so sending to a
//     grade twice adds only the students who weren't asked yet.
//   - Nothing with money on it is deleted: a charge with any payment history
//     is waived instead, and a request with any payment can't be deleted.
//   - The amount can change only while nobody has paid anything. The tax
//     rate and whether tax is added or included count as the amount.
//   - Each family's charge is one line: the request's amount and its tax (a
//     copy of the rate, so editing the rate later changes no charge). What
//     the family owes is the amount plus any tax added on top.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/paymentRequests.queries');
const chargeQueries = require('../../queries/charges.queries');
const charges = require('./charges');
const emails = require('./emails');
const { guardiansFor } = require('./guardians');
const { MIN_ITEM_CENTS, MAX_ITEM_CENTS } = require('./paymentField');
const { balanceCents } = require('./chargeStatus');
const tax = require('./tax');
const taxSettings = require('./taxSettings');

const { ChargeError } = charges;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STUDENTS = 2000;
const GRADE_ORDER = ['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8'];
const gradeRank = (grade) => {
  const i = GRADE_ORDER.indexOf(String(grade));
  return i === -1 ? GRADE_ORDER.length : i;
};

const text = (value, max) => {
  const s = String(value ?? '').replace(/<[^>]*>/g, '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Checks what the office typed. `partial` (an edit) only checks the keys sent.
 * Whether a tax rate is the school's is checked against the database later.
 * @returns {{ title?, description?, amountCents?, dueDate?, allowOffline?, accountingCode?, taxRateId?, taxMode? }}
 */
function normalizeRequest(body = {}, { partial = false } = {}) {
  const out = {};
  const has = (key) => !partial || Object.prototype.hasOwnProperty.call(body, key);
  if (has('title')) {
    out.title = text(body.title, 120);
    if (!out.title) throw new ChargeError('Give the request a name, like "Grade 5 trip to the museum".', 400);
  }
  if (has('description')) out.description = text(body.description, 2000);
  if (has('amountCents')) {
    const amount = Number(body.amountCents);
    if (!Number.isInteger(amount) || amount < MIN_ITEM_CENTS || amount > MAX_ITEM_CENTS) {
      throw new ChargeError('Enter an amount between $0.50 and $10,000.00.', 400);
    }
    out.amountCents = amount;
  }
  if (has('dueDate')) {
    const due = body.dueDate == null || body.dueDate === '' ? null : String(body.dueDate);
    if (due !== null && (!DATE_RE.test(due) || Number.isNaN(Date.parse(`${due}T12:00:00Z`)))) {
      throw new ChargeError('Enter the due date as a date.', 400);
    }
    out.dueDate = due;
  }
  if (has('allowOffline')) out.allowOffline = body.allowOffline === undefined ? true : Boolean(body.allowOffline);
  if (has('accountingCode')) out.accountingCode = text(body.accountingCode, 60);
  if (has('taxRateId')) {
    const id = body.taxRateId == null || body.taxRateId === '' ? null : String(body.taxRateId);
    if (id !== null && !UUID_RE.test(id)) throw new ChargeError(taxSettings.BAD_RATE, 400);
    out.taxRateId = id;
  }
  if (has('taxMode')) out.taxMode = tax.normalizeMode(body.taxMode);
  return out;
}

/** The rate a request row names ({ name, rateMilli, archived }), or null. */
const rateOf = (request) => (request.tax_rate_id && request.tax_rate ? request.tax_rate : null);

/** Each family's line: the amount as typed, its tax, and what the family owes. */
function requestLine(amountCents, rate, mode) {
  const line = tax.taxLine(amountCents, rate, mode);
  return { ...line, totalCents: amountCents + (line.taxIncluded ? 0 : line.taxCents) };
}

/** Who to send to: picked students, whole grades and whole classes, in the school's year. */
function normalizeTarget(body = {}) {
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => UUID_RE.test(String(id))) : []);
  const target = {
    studentIds: ids(body.studentIds),
    classIds: ids(body.classIds),
    grades: Array.isArray(body.grades) ? body.grades.map(String).filter((g) => GRADE_ORDER.includes(g)) : [],
  };
  if (target.studentIds.length + target.classIds.length + target.grades.length === 0) {
    throw new ChargeError('Choose who to send it to: a grade, a class or students.', 400);
  }
  return target;
}

async function resolveStudents(conn, { school, schoolYearId, target }) {
  const { rows } = await conn.query(q.selectTargetStudents, [school, schoolYearId, target.studentIds, target.grades, target.classIds]);
  if (rows.length > MAX_STUDENTS) throw new ChargeError(`That is more than ${MAX_STUDENTS} students. Send it in parts.`, 400);
  return rows.map((r) => r.student_id);
}

async function inTransaction(work) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * Makes the charges for new students and queues their guardians' emails.
 * `rate` is the request's tax rate as it stands now (or null).
 * @returns the charges made
 */
async function addCharges(tx, request, studentIds, { account, notify, rate }) {
  const made = [];
  const line = requestLine(request.amount_cents, rate, request.tax_mode);
  for (const studentId of studentIds) {
    const { rows: [charge] } = await tx.query(chargeQueries.insertRequestCharge, [
      request.school, request.livemode, request.request_id, studentId, request.title, request.currency,
      line.totalCents, request.accounting_code, account?.payment_account_id || null, line.taxCents,
    ]);
    if (!charge) continue; // asked already
    await tx.query(chargeQueries.insertLine, charges.lineParams(charge.charge_id, { itemId: null, label: request.title, ...line }, 0));
    if (notify) {
      const queued = await emails.queueRequest(tx, charge);
      if (queued > 0) await tx.query(chargeQueries.markLinkSent, [charge.charge_id]);
    }
    made.push(charge);
  }
  return made;
}

async function loadRequest(conn, { school, livemode, requestId, lock = false }) {
  if (!UUID_RE.test(String(requestId))) throw new ChargeError('Payment request not found', 404);
  const { rows: [request] } = await conn.query(lock ? q.selectRequestForUpdate : q.selectRequest, [requestId, school, livemode]);
  if (!request) throw new ChargeError('Payment request not found', 404);
  return request;
}

/** Card payments need Stripe; without it, the family pays at the office. */
async function checkCanCollect(school, allowOffline) {
  const pay = await charges.availability(school);
  if (!pay.online && !allowOffline) {
    throw new ChargeError('Connect Stripe to take card payments, or allow paying at the office.', 409, 'PAYMENTS_UNAVAILABLE');
  }
  return pay;
}

// ─── Shaping ──────────────────────────────────────────────────────────

function toRequest(row) {
  const rate = rateOf(row);
  const mode = tax.normalizeMode(row.tax_mode);
  const line = requestLine(row.amount_cents, rate, mode);
  return {
    requestId: row.request_id,
    title: row.title,
    description: row.description,
    currency: row.currency,
    // The price as typed, per student; with its tax (at the rate as it stands now), what each family owes.
    amountCents: row.amount_cents,
    taxRateId: row.tax_rate_id || null,
    taxName: rate ? rate.name : null,
    taxRateMilli: rate ? rate.rateMilli : null,
    taxArchived: rate ? Boolean(rate.archived) : false,
    taxMode: mode,
    taxPerStudentCents: line.taxCents,
    totalPerStudentCents: line.totalCents,
    dueDate: row.due_date_text ?? null,
    allowOffline: row.allow_offline,
    accountingCode: row.accounting_code,
    createdAt: row.created_at,
    createdByName: row.created_by_name || null,
    stats: row.students_count === undefined ? undefined : {
      students: row.students_count,
      settled: row.settled_count,
      open: row.open_count,
      expectedCents: Number(row.expected_cents) || 0,
      collectedCents: Number(row.collected_cents) || 0,
      outstandingCents: Number(row.outstanding_cents) || 0,
      waivedCents: Number(row.waived_cents) || 0,
    },
  };
}

// ─── Reads ────────────────────────────────────────────────────────────

async function list({ school, livemode }) {
  const { rows } = await db.query(q.listRequests, [school, livemode]);
  return rows.map(toRequest);
}

async function detail({ school, livemode, requestId }) {
  const request = await loadRequest(db, { school, livemode, requestId });
  const [{ rows: [stats] }, { rows: chargeRows }] = await Promise.all([
    db.query(q.requestStats, [request.request_id]),
    db.query(q.selectRequestCharges, [request.request_id]),
  ]);
  const guardians = await guardiansFor(db, chargeRows.map((c) => c.student_id));
  return {
    ...toRequest({ ...request, ...stats }),
    charges: chargeRows.map((row) => ({
      ...charges.toCharge(row, { finance: true }),
      // Who the request went to: the family's addresses are what the office checks when an email bounced.
      guardianEmails: (guardians.get(row.student_id) || []).map((g) => g.email),
    })),
  };
}

/** The students and classes of the school's year, for "who to send it to". */
async function roster({ school, schoolYearId }) {
  const [{ rows: students }, { rows: classes }] = await Promise.all([
    db.query(q.rosterStudents, [school, schoolYearId]),
    db.query(q.rosterClasses, [school, schoolYearId]),
  ]);
  const guardians = await guardiansFor(db, students.map((s) => s.student_id));
  return {
    students: students
      .map((s) => ({
        studentId: s.student_id,
        name: s.name,
        grade: s.grade,
        classIds: s.class_ids || [],
        hasGuardianEmail: (guardians.get(s.student_id) || []).length > 0,
      }))
      .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || a.name.localeCompare(b.name)),
    classes: classes
      .map((c) => ({ classId: c.class_id, name: c.subject, grade: c.grade, teacherName: c.teacher_name, studentCount: c.student_count }))
      .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || a.name.localeCompare(b.name)),
  };
}

// ─── The office's actions ─────────────────────────────────────────────

/** Makes a request, its charges, and the emails to each student's guardians. */
async function create({ school, livemode, schoolYearId, body, user }) {
  const fields = normalizeRequest(body);
  const target = normalizeTarget(body);
  const notify = body.notify !== false;
  const pay = await checkCanCollect(school, fields.allowOffline);
  const result = await inTransaction(async (tx) => {
    const rate = await taxSettings.resolveForRequest(tx, school, fields.taxRateId);
    const studentIds = await resolveStudents(tx, { school, schoolYearId, target });
    if (studentIds.length === 0) throw new ChargeError('No students match who you chose.', 400);
    const { rows: [request] } = await tx.query(q.insertRequest, [
      school, livemode, schoolYearId, fields.title, fields.description, fields.amountCents, fields.dueDate,
      fields.allowOffline, fields.accountingCode, user.userId, rate ? rate.taxRateId : null, fields.taxMode,
    ]);
    const made = await addCharges(tx, request, studentIds, { account: pay.account, notify, rate });
    return { request, made };
  });
  if (notify) emails.kick();
  logger.info({ school, userId: user.userId, requestId: result.request.request_id, students: result.made.length }, 'Payments: payment request sent');
  return { requestId: result.request.request_id, added: result.made.length };
}

/** Sends an existing request to more students; anyone asked already is skipped. */
async function addStudents({ school, livemode, schoolYearId, requestId, body, user }) {
  const target = normalizeTarget(body);
  const notify = body.notify !== false;
  const result = await inTransaction(async (tx) => {
    const request = await loadRequest(tx, { school, livemode, requestId, lock: true });
    const pay = await checkCanCollect(school, request.allow_offline);
    const studentIds = await resolveStudents(tx, { school, schoolYearId: request.school_year_id || schoolYearId, target });
    return addCharges(tx, request, studentIds, { account: pay.account, notify, rate: rateOf(request) });
  });
  if (notify && result.length > 0) emails.kick();
  logger.info({ school, userId: user.userId, requestId, added: result.length }, 'Payments: students added to a payment request');
  return { added: result.length };
}

/** Takes a student off a request. Only before anything was paid; after that, waive it. */
async function removeCharge({ school, livemode, requestId, chargeId }) {
  return inTransaction(async (tx) => {
    await loadRequest(tx, { school, livemode, requestId, lock: true });
    const { rows: [charge] } = await tx.query(
      'SELECT charge_id FROM charges WHERE charge_id = $1 AND request_id = $2 FOR UPDATE',
      [chargeId, requestId],
    );
    if (!charge) throw new ChargeError('That student isn’t on this request.', 404);
    const { rows: [{ n }] } = await tx.query(chargeQueries.countPayments, [chargeId]);
    if (n > 0) throw new ChargeError('This family has a payment on record. Waive what is left instead.', 409, 'HAS_PAYMENTS');
    await tx.query(chargeQueries.deleteCharge, [chargeId]);
    return { removed: true };
  });
}

/**
 * Edits a request. The name and amount are copied onto each family's charge;
 * the amount can change only while nobody has paid anything. Changing the
 * tax rate, or whether a rate is added or included, counts as changing the
 * amount: every family's charge and line is rewritten and recomputed.
 */
async function update({ school, livemode, requestId, body }) {
  const fields = normalizeRequest(body, { partial: true });
  return inTransaction(async (tx) => {
    const request = await loadRequest(tx, { school, livemode, requestId, lock: true });
    const allowOffline = fields.allowOffline ?? request.allow_offline;
    if (fields.allowOffline === false) await checkCanCollect(school, false);
    const taxRateId = fields.taxRateId !== undefined ? fields.taxRateId : request.tax_rate_id;
    const taxMode = fields.taxMode ?? request.tax_mode;
    // A rate removed since it was chosen may stay on this request; no other archived one.
    const rate = await taxSettings.resolveForRequest(tx, school, taxRateId, { keep: request.tax_rate_id });
    const amountChanges = fields.amountCents !== undefined && fields.amountCents !== request.amount_cents;
    // Without a rate, added or included makes no difference to anyone's amount.
    const taxChanges = (taxRateId || null) !== (request.tax_rate_id || null) || (Boolean(taxRateId) && taxMode !== request.tax_mode);
    if (amountChanges || taxChanges) {
      const { rows: [{ n }] } = await tx.query(q.countRequestPayments, [requestId]);
      if (n > 0) {
        throw new ChargeError(amountChanges
          ? 'Families have paid already, so the amount can’t change. Waive or refund instead.'
          : 'Families have paid already, so the tax can’t change. Waive or refund instead.', 409, 'HAS_PAYMENTS');
      }
    }
    const next = {
      title: fields.title ?? request.title,
      description: fields.description !== undefined ? fields.description : request.description,
      amountCents: fields.amountCents ?? request.amount_cents,
      dueDate: fields.dueDate !== undefined ? fields.dueDate : request.due_date_text,
      allowOffline,
      accountingCode: fields.accountingCode !== undefined ? fields.accountingCode : request.accounting_code,
    };
    await tx.query(q.updateRequest, [
      requestId, next.title, next.description, next.amountCents, next.dueDate, next.allowOffline, next.accountingCode,
      rate ? rate.taxRateId : null, taxMode,
    ]);
    await tx.query(q.updateRequestCharges, [requestId, next.title, next.accountingCode]);
    if (amountChanges || taxChanges) {
      const line = requestLine(next.amountCents, rate, taxMode);
      await tx.query(q.updateRequestMoney, [requestId, line.totalCents, line.taxCents]);
      await tx.query(q.updateRequestLines, [
        requestId, next.title, line.amountCents, line.taxCents, line.taxName, line.taxRateMilli, line.taxIncluded,
      ]);
      const { rows } = await tx.query('SELECT charge_id FROM charges WHERE request_id = $1', [requestId]);
      for (const row of rows) await charges.recompute(tx, row.charge_id);
    } else if (fields.title) {
      await tx.query(q.renameRequestLines, [requestId, next.title]);
    }
    return { requestId };
  });
}

/** Deletes a request nobody has paid anything on. */
async function remove({ school, livemode, requestId }) {
  return inTransaction(async (tx) => {
    await loadRequest(tx, { school, livemode, requestId, lock: true });
    const { rows: [{ n }] } = await tx.query(q.countRequestPayments, [requestId]);
    if (n > 0) throw new ChargeError('Families have paid on this request, so it can’t be deleted.', 409, 'HAS_PAYMENTS');
    await tx.query('DELETE FROM charges WHERE request_id = $1', [requestId]);
    await tx.query('DELETE FROM payment_requests WHERE request_id = $1', [requestId]);
    return { deleted: true };
  });
}

/** Reminds every family that still owes on the request. @returns how many families */
async function remind({ school, livemode, requestId, user }) {
  const request = await loadRequest(db, { school, livemode, requestId });
  const { rows: open } = await db.query(q.selectOpenRequestCharges, [request.request_id]);
  let families = 0;
  await inTransaction(async (tx) => {
    for (const charge of open) {
      const queued = await emails.queueRequest(tx, charge, { reminder: 'manual' });
      if (queued > 0) {
        families += 1;
        await tx.query(chargeQueries.markLinkSent, [charge.charge_id]);
      }
    }
  });
  if (families > 0) emails.kick();
  logger.info({ school, userId: user.userId, requestId, families }, 'Payments: payment request reminders sent');
  return { reminded: families, open: open.length };
}

/**
 * The automatic reminder, three days before a request is due: once per
 * family. Run by the payments worker's daily pass.
 * @returns how many families were reminded
 */
async function sendDueSoonReminders({ livemode, today }) {
  const { rows } = await db.query(q.selectDueSoonCharges, [livemode, today]);
  let sent = 0;
  for (const charge of rows) {
    try {
      const { rows: claimed } = await db.query(chargeQueries.claimReminder, [charge.charge_id]);
      if (!claimed[0]) continue;
      if (balanceCents({ amountCents: charge.amount_cents, amountPaidCents: charge.amount_paid_cents, status: charge.status }) <= 0) continue;
      if (await emails.queueRequest(db, charge, { reminder: 'due_soon' })) sent += 1;
    } catch (error) {
      logger.warn({ chargeId: charge.charge_id, err: error.message }, 'Payments: could not queue a due-date reminder');
    }
  }
  if (sent > 0) emails.kick();
  return sent;
}

module.exports = {
  normalizeRequest,
  normalizeTarget,
  list,
  detail,
  roster,
  create,
  addStudents,
  removeCharge,
  update,
  remove,
  remind,
  sendDueSoonReminders,
  gradeRank,
  requestLine,
};
