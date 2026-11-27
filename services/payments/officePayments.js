// services/payments/officePayments.js
//
// Cash for a student who never sent the form in: the office records the
// family's payment on a form, and the response, its charge and the payment
// are made together.
//
// Rules this module keeps:
//   - All of it happens in one transaction: the response (for the student,
//     entered by the staff member, the school's default status, its only
//     answer the payment summary), its charge (priced from the form like any
//     response: required items always, the optional ones ticked, tax as
//     usual) and the payment, through the same code as any office payment
//     (charges.recordOfflineIn). A refused amount leaves nothing behind.
//   - A student is entered once per form: a second try answers 409
//     ALREADY_ON_FORM with the charge to open instead. Two clicks at once
//     wait for each other (an advisory lock on the form and student).
//   - The receipt goes to the student's guardians (the charge has no payer
//     email), unless the office says not to.

const db = require('../../config/database');
const logger = require('../../logger');
const registrationQueries = require('../../queries/registration.queries');
const googleSheetsQueries = require('../../queries/googleSheets.queries');
const charges = require('./charges');
const emails = require('./emails');
const taxSettings = require('./taxSettings');
const { priceSelection, summaryAnswer, PaymentFieldError } = require('./paymentField');

const { ChargeError } = charges;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/registration/forms/:formId/office-payments
 * body: { studentId, itemIds?, kind, amountCents?, note?, sendReceipt? }
 * @returns the charge as staff see it (charges.detailForStaff)
 */
async function recordForStudent({ school, formId, body = {}, user }) {
  const { studentId, kind } = body;
  if (!charges.OFFLINE_KINDS.has(kind)) throw new ChargeError('Choose cash, cheque or other', 400);
  if (!UUID_RE.test(String(formId))) throw new ChargeError('Form not found', 404);
  if (!UUID_RE.test(String(studentId || ''))) throw new ChargeError('Student not found', 404);

  const { rows: [form] } = await db.query(registrationQueries.selectFormById, [formId, school]);
  if (!form) throw new ChargeError('Form not found', 404);
  const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);
  const field = fields.find((f) => f.field_type === 'payment' && f.payment_config);
  if (!field) throw new ChargeError('This form doesn’t ask for a payment.', 400, 'NO_PAYMENT_FIELD');
  const { rows: [student] } = await db.query('SELECT student_id FROM students WHERE student_id = $1 AND school = $2', [studentId, school]);
  if (!student) throw new ChargeError('Student not found', 404);

  let priced;
  try {
    priced = priceSelection(field.payment_config, body.itemIds, await taxSettings.ratesById(school));
  } catch (error) {
    if (error instanceof PaymentFieldError) throw new ChargeError(error.message, 400);
    throw error;
  }
  if (priced.totalCents <= 0) throw new ChargeError('Tick what the family is paying for.', 400, 'NOTHING_TO_PAY');

  const pay = await charges.availability(school);
  const livemode = pay.client ? pay.client.livemode : false;
  const sendReceipt = body.sendReceipt !== false;

  const result = await charges.inTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`office-payment:${form.form_id}:${student.student_id}`]);
    const { rows: [existing] } = await tx.query(registrationQueries.selectStudentChargeOnForm, [form.form_id, school, student.student_id, livemode]);
    if (existing) {
      throw new ChargeError('This student already has a payment on this form. Open it to record the payment.', 409, 'ALREADY_ON_FORM', { chargeId: existing.charge_id });
    }
    const { rows: [submission] } = await tx.query(registrationQueries.insertOfficeSubmission, [
      form.form_id, school, JSON.stringify({ [field.field_id]: summaryAnswer(priced, 'offline') }), student.student_id, user.userId,
    ]);
    const charge = await charges.createForSubmission(tx, {
      school,
      livemode,
      submissionId: submission.submission_id,
      form,
      field,
      priced,
      method: 'offline',
      payerEmail: null,
      studentId: student.student_id,
      account: pay.account,
    });
    return charges.recordOfflineIn(tx, {
      school, livemode, chargeId: charge.charge_id, kind, amountCents: body.amountCents ?? null, note: body.note, user, sendReceipt,
    });
  });
  if (sendReceipt) emails.kick();

  // A linked sheet picks the new response up; never let that fail the payment.
  try {
    await db.query(googleSheetsQueries.enqueueJob, [form.form_id]);
  } catch (error) {
    logger.warn({ err: error, formId: form.form_id }, 'Could not queue sheet sync');
  }
  logger.info({ school, userId: user.userId, formId: form.form_id, chargeId: result.charge.charge_id, kind }, 'Payments: office payment for a student without a response');
  return charges.detailForStaff({ school, livemode, chargeId: result.charge.charge_id, finance: true });
}

module.exports = { recordForStudent };
