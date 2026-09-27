// controllers/financeFamilies.controller.js
//
// Admin writes for the family model: families, their students and contacts,
// the QuickBooks customer link, invoice-kind overrides, the roster import,
// and the read-only helpers the linking wizard needs (customer picker,
// suggestions). Every change writes a family_link_audit row.
//
// Nothing here touches QuickBooks; the cache is read, never written.

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/finance.queries');
const schoolYearQueries = require('../queries/schoolYear.queries');
const { planSeed, applySeed } = require('../services/finance/familySeed');
const { suggestForFamilies, suggestForCustomers, suggestFamilyForStudent } = require('../services/finance/suggestions');
const { resolveSettings } = require('../services/finance/classify');
const { buildLinkIndex, monthWindow } = require('../services/finance/gridAssembly');
const { loadFamilyYear, toStudent, toContact } = require('../services/finance/familyShape');
const { num, round2, dateStr } = require('../services/finance/util');

const fail = (res, status, message, extra = {}) => res.status(status).json({ status: 'failed', message, ...extra });
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

const ID_RE = /^\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STUDENTS_PER_REQUEST = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date in YYYY-MM-DD (the regex alone accepts 2026-13-45).
const isValidDate = (s) => {
  if (!DATE_RE.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RELATIONS = new Set(['mother', 'father', 'guardian', 'other']);
const KINDS = new Set(['parent', 'subsidy_grant', 'subsidy_school', 'other']);
const torontoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const shiftDay = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dayBefore = (iso) => shiftDay(iso, -1);
const dayAfter = (iso) => shiftDay(iso, 1);

// ─── Validation ───────────────────────────────────────────────────────

const cleanName = (v) => (typeof v === 'string' ? v.trim() : '');
function amountOrNull(v, label) {
  if (v === undefined || v === null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative amount` };
  return { value: round2(n) };
}
function validateContact(body, { partial = false } = {}) {
  const out = {};
  if (body.name !== undefined) out.name = body.name === null ? null : cleanName(body.name) || null;
  if (body.email !== undefined) {
    const e = body.email === null ? null : String(body.email).trim().toLowerCase();
    if (e && !EMAIL_RE.test(e)) return { error: 'Invalid email address' };
    out.email = e || null;
  }
  if (body.phone !== undefined) out.phone = body.phone === null ? null : String(body.phone).trim() || null;
  if (body.relation !== undefined) {
    const r = body.relation === null ? null : String(body.relation).trim().toLowerCase();
    if (r && !RELATIONS.has(r)) return { error: 'Relation must be mother, father, guardian or other' };
    out.relation = r || null;
  }
  if (body.isPrimary !== undefined) out.isPrimary = Boolean(body.isPrimary);
  if (!partial && !out.name && !out.email) return { error: 'A contact needs a name or an email' };
  return { value: out };
}

// ─── Shaping ──────────────────────────────────────────────────────────

/** FamilySummary rows for a year (optionally one family). */
async function loadFamilySummaries(school, yearId, { familyId = null } = {}) {
  const [{ families, studentsBy, contactsBy, linkIndex }, customers] = await Promise.all([
    loadFamilyYear(db, school, yearId),
    db.query(queries.selectCustomerSummaries, [school]).then((r) => r.rows),
  ]);
  const customerById = new Map(customers.map((c) => [c.qbo_id, c]));
  const rows = familyId ? families.filter((f) => f.family_id === familyId) : families;
  return rows.map((f) => {
    const current = linkIndex.currentFor(f.family_id);
    const c = current ? customerById.get(current.customerId) : null;
    return {
      familyId: f.family_id, name: f.name, isSubsidy: Boolean(f.is_subsidy), isTeacher: Boolean(f.is_teacher), notes: f.notes ?? null,
      expectedMonthlyParent: num(f.expected_monthly_parent), expectedMonthlySubsidy: num(f.expected_monthly_subsidy), rosterFamilyNo: f.roster_family_no ?? null,
      customer: current ? { qboId: current.customerId, displayName: c?.display_name || `Customer ${current.customerId}`, isSubCustomer: Boolean(c?.is_sub_customer), active: c ? c.active !== false : true } : null,
      students: (studentsBy.get(f.family_id) || []).map(toStudent),
      contacts: (contactsBy.get(f.family_id) || []).map(toContact),
      createdAt: f.created_at, updatedAt: f.updated_at,
    };
  });
}

async function loadFamily(req, res) {
  const { rows } = await db.query(queries.selectFamilyById, [req.user.school, req.params.familyId]);
  if (!rows[0]) { fail(res, 404, 'Family not found'); return null; }
  return rows[0];
}

const summaryFor = async (req, family) => (await loadFamilySummaries(req.user.school, family.school_year_id, { familyId: family.family_id }))[0];

async function audit(client, { school, yearId, familyId, familyName, action, oldCustomer = null, newCustomer = null, studentId = null, invoiceId = null, details = null, actor }) {
  await client.query(queries.insertAudit, [school, yearId, familyId, familyName, action, oldCustomer, newCustomer, studentId, invoiceId, details ? JSON.stringify(details) : null, actor]);
}

/** Inserts a student into a family, or explains why it cannot. Returns { ok } or { status, body }. */
async function attachStudent(client, family, studentId) {
  const familyId = family.family_id;
  const { rowCount } = await client.query(queries.insertFamilyStudent, [familyId, studentId]);
  if (rowCount > 0) return { ok: true };
  const { rows } = await client.query(queries.selectFamilyHoldingStudent, [studentId, family.school, family.school_year_id]);
  if (rows[0] && rows[0].family_id !== familyId) {
    return { status: 409, body: { message: `This student is already in the family "${rows[0].name}"`, code: 'STUDENT_IN_FAMILY', studentId } };
  }
  if (rows[0]) return { ok: true }; // already in this family
  return { status: 400, body: { message: 'Student is not in this school year' } };
}

/** Confirms a customer exists in the cache and is not open-linked to another family this year. */
async function checkCustomerAvailable(client, school, customerId, familyId, yearId) {
  const { rows: cust } = await client.query(queries.selectCustomerById, [school, customerId]);
  if (!cust[0]) return { status: 400, body: { message: 'Unknown QuickBooks customer' } };
  const { rows: open } = await client.query(queries.selectOpenLinkForCustomer, [school, customerId, yearId]);
  if (open[0] && open[0].family_id !== familyId) {
    return { status: 409, body: { message: `This QuickBooks customer already bills the family "${open[0].name}"`, code: 'CUSTOMER_LINKED', familyId: open[0].family_id } };
  }
  return { ok: true };
}

async function backfillSince(school) {
  const { rows } = await db.query(queries.selectConnection, [school]);
  return resolveSettings(rows[0]?.settings || {}).backfillSince;
}

// ─── Families ─────────────────────────────────────────────────────────

const listFamilies = async (req, res) => {
  try {
    if (!req.schoolYear) return fail(res, 400, 'No school year configured for your school');
    let families = await loadFamilySummaries(req.user.school, req.schoolYear.schoolYearId);
    const linked = String(req.query.linked || 'all');
    if (linked === 'linked') families = families.filter((f) => f.customer);
    if (linked === 'unlinked') families = families.filter((f) => !f.customer);
    const q = String(req.query.search || '').trim().toLowerCase();
    if (q) {
      families = families.filter((f) => f.name.toLowerCase().includes(q)
        || f.students.some((s) => s.name.toLowerCase().includes(q))
        || f.contacts.some((c) => (c.email || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        || (f.customer?.displayName || '').toLowerCase().includes(q));
    }
    return ok(res, { families });
  } catch (error) {
    logger.error({ err: error }, 'Error listing families');
    return fail(res, 500, 'Error listing families');
  }
};

const createFamily = async (req, res) => {
  const { school, userId } = req.user;
  if (!req.schoolYear) return fail(res, 400, 'No school year configured for your school');
  const yearId = req.schoolYear.schoolYearId;
  const body = req.body || {};

  const name = cleanName(body.name);
  if (!name || name.length > 200) return fail(res, 400, 'Family name is required');
  const studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : []).map(String))];
  if (studentIds.some((id) => !UUID_RE.test(id))) return fail(res, 400, 'studentIds must be student ids');
  if (studentIds.length > MAX_STUDENTS_PER_REQUEST) return fail(res, 400, `At most ${MAX_STUDENTS_PER_REQUEST} students per request`);
  const customerId = body.qboCustomerId === undefined || body.qboCustomerId === null || body.qboCustomerId === '' ? null : String(body.qboCustomerId);
  if (customerId && !ID_RE.test(customerId)) return fail(res, 400, 'Invalid QuickBooks customer id');
  const parent = amountOrNull(body.expectedMonthlyParent, 'Expected monthly (parent)');
  const subsidy = amountOrNull(body.expectedMonthlySubsidy, 'Expected monthly (subsidy)');
  if (parent.error || subsidy.error) return fail(res, 400, parent.error || subsidy.error);
  const contacts = [];
  for (const c of Array.isArray(body.contacts) ? body.contacts : []) {
    const v = validateContact(c || {});
    if (v.error) return fail(res, 400, v.error);
    contacts.push(v.value);
  }
  const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim() || null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(queries.insertFamily, [school, yearId, name, Boolean(body.isSubsidy), Boolean(body.isTeacher), parent.value, subsidy.value, notes, userId]);
    const family = rows[0];

    for (const sid of studentIds) {
      const r = await attachStudent(client, family, sid);
      if (!r.ok) { await client.query('ROLLBACK'); return fail(res, r.status, r.body.message, r.body); }
    }

    let primaryId = null;
    for (const c of contacts) {
      const { rows: ins } = await client.query(queries.insertContact, [family.family_id, c.name || null, c.email || null, c.phone || null, c.relation || null, 'manual']);
      if (c.isPrimary && ins[0]) primaryId = ins[0].contact_id;
    }
    if (primaryId) {
      await client.query(queries.clearPrimaryContact, [family.family_id, primaryId]);
      await client.query(queries.setPrimaryContact, [family.family_id, primaryId]);
    }

    if (customerId) {
      const avail = await checkCustomerAvailable(client, school, customerId, family.family_id, yearId);
      if (!avail.ok) { await client.query('ROLLBACK'); return fail(res, avail.status, avail.body.message, avail.body); }
      const { rows: closed } = await client.query(queries.selectLatestClosedLinkForCustomer, [school, customerId, yearId, family.family_id]);
      const from = closed[0]?.latest_to ? dayAfter(closed[0].latest_to) : await backfillSince(school);
      await client.query(queries.openLink, [school, family.family_id, customerId, from, userId]);
    }

    await audit(client, { school, yearId, familyId: family.family_id, familyName: name, action: 'family_create', newCustomer: customerId, details: { studentIds, contacts: contacts.length }, actor: userId });
    await client.query('COMMIT');
    return ok(res, await summaryFor(req, family), 201);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') return uniqueViolation(res, error);
    logger.error({ err: error }, 'Error creating family');
    return fail(res, 500, 'Error creating family');
  } finally {
    client.release();
  }
};

const updateFamily = async (req, res) => {
  const { school, userId } = req.user;
  const body = req.body || {};
  const editable = ['name', 'isSubsidy', 'isTeacher', 'expectedMonthlyParent', 'expectedMonthlySubsidy', 'notes'];
  if (!editable.some((k) => body[k] !== undefined)) return fail(res, 400, 'Nothing to update');
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;

    const name = body.name === undefined ? family.name : cleanName(body.name);
    if (!name || name.length > 200) return fail(res, 400, 'Family name is required');
    const parent = body.expectedMonthlyParent === undefined ? { value: num(family.expected_monthly_parent) } : amountOrNull(body.expectedMonthlyParent, 'Expected monthly (parent)');
    const subsidy = body.expectedMonthlySubsidy === undefined ? { value: num(family.expected_monthly_subsidy) } : amountOrNull(body.expectedMonthlySubsidy, 'Expected monthly (subsidy)');
    if (parent.error || subsidy.error) return fail(res, 400, parent.error || subsidy.error);
    const notes = body.notes === undefined ? family.notes : (body.notes === null ? null : String(body.notes).trim() || null);

    const { rows } = await db.query(queries.updateFamily, [
      school, family.family_id, name,
      body.isSubsidy === undefined ? Boolean(family.is_subsidy) : Boolean(body.isSubsidy),
      body.isTeacher === undefined ? Boolean(family.is_teacher) : Boolean(body.isTeacher),
      parent.value, subsidy.value, notes,
    ]);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: name, action: 'family_update', details: { changed: editable.filter((k) => body[k] !== undefined) }, actor: userId });
    return ok(res, await summaryFor(req, rows[0]));
  } catch (error) {
    logger.error({ err: error }, 'Error updating family');
    return fail(res, 500, 'Error updating family');
  }
};

const deleteFamily = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    await db.query(queries.deleteFamily, [school, family.family_id]);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'family_delete', details: { rosterFamilyNo: family.roster_family_no }, actor: userId });
    return ok(res, { deleted: true });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting family');
    return fail(res, 500, 'Error deleting family');
  }
};

// Which unique index tripped decides the message; anything else is a plain 409.
function uniqueViolation(res, error) {
  if (error.constraint === 'uq_fcl_open_per_customer') return fail(res, 409, 'This QuickBooks customer already bills another family', { code: 'CUSTOMER_LINKED' });
  if (error.constraint === 'uq_family_contacts_email') return fail(res, 409, 'A contact with that email already exists on this family');
  if (error.constraint === 'family_students_student_id_key') return fail(res, 409, 'This student is already in a family', { code: 'STUDENT_IN_FAMILY' });
  return fail(res, 409, 'That would duplicate an existing record');
}

// ─── Customer link ────────────────────────────────────────────────────

/**
 * Link (or relink) a family to a QuickBooks customer.
 *
 * Three cases, all inside one transaction so a collision never leaves the
 * family half-linked:
 *   first link        starts at the backfill date, or the day after another
 *                     family's closed link to the same customer ended
 *   switch (default)  the current link closes the day before `effectiveFrom`
 *                     (today unless given); history is kept
 *   replace: true     the current link was a mistake: it is deleted and the
 *                     new one starts where it started, moving the whole year
 */
const linkCustomer = async (req, res) => {
  const { school, userId } = req.user;
  const customerId = String(req.body?.qboCustomerId ?? '');
  if (!ID_RE.test(customerId)) return fail(res, 400, 'Invalid QuickBooks customer id');
  const effectiveFrom = req.body?.effectiveFrom;
  if (effectiveFrom !== undefined && !isValidDate(effectiveFrom)) return fail(res, 400, 'effectiveFrom must be a valid YYYY-MM-DD date');
  const replace = Boolean(req.body?.replace);

  const family = await loadFamily(req, res).catch((error) => { logger.error({ err: error }, 'Error loading family'); return null; });
  if (!family) return res.headersSent ? undefined : fail(res, 500, 'Error linking customer');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const avail = await checkCustomerAvailable(client, school, customerId, family.family_id, family.school_year_id);
    if (!avail.ok) { await client.query('ROLLBACK'); return fail(res, avail.status, avail.body.message, avail.body); }

    const { rows: open } = await client.query(queries.selectOpenLinkForFamily, [family.family_id]);
    const current = open[0] || null;
    if (current && current.qbo_customer_id === customerId) { await client.query('COMMIT'); return ok(res, await summaryFor(req, family)); }

    // Never overlap another family's closed range for this customer.
    const { rows: closed } = await client.query(queries.selectLatestClosedLinkForCustomer, [school, customerId, family.school_year_id, family.family_id]);
    const latestTo = closed[0]?.latest_to || null;
    const earliest = latestTo ? dayAfter(latestTo) : null;

    let from;
    if (current && replace) from = effectiveFrom || dateStr(current.effective_from);
    else if (current) from = effectiveFrom || torontoToday();
    else from = effectiveFrom || earliest || await backfillSince(school);

    if (earliest && from < earliest) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Another family was billed through this customer until ${latestTo}; the earliest start date is ${earliest}`, { code: 'LINK_OVERLAP', earliestFrom: earliest });
    }

    if (current && replace) {
      await client.query(queries.deleteLink, [current.link_id]);
    } else if (current) {
      if (dayBefore(from) < dateStr(current.effective_from)) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'The new link cannot start before the current one did; use replace to correct a wrong link');
      }
      await client.query(queries.closeLink, [current.link_id, dayBefore(from)]);
    }
    await client.query(queries.openLink, [school, family.family_id, customerId, from, userId]);
    await audit(client, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'customer_link',
      oldCustomer: current?.qbo_customer_id ?? null, newCustomer: customerId, details: { effectiveFrom: from, replaced: Boolean(current && replace) }, actor: userId });
    await client.query('COMMIT');
    return ok(res, await summaryFor(req, family));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') return uniqueViolation(res, error);
    logger.error({ err: error }, 'Error linking customer');
    return fail(res, 500, 'Error linking customer');
  } finally {
    client.release();
  }
};

const unlinkCustomer = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const { rows: open } = await db.query(queries.selectOpenLinkForFamily, [family.family_id]);
    if (!open[0]) return fail(res, 409, 'This family has no QuickBooks customer linked');
    const today = torontoToday();
    const to = today < dateStr(open[0].effective_from) ? dateStr(open[0].effective_from) : today;
    await db.query(queries.closeLink, [open[0].link_id, to]);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'customer_unlink', oldCustomer: open[0].qbo_customer_id, details: { effectiveTo: to }, actor: userId });
    return ok(res, await summaryFor(req, family));
  } catch (error) {
    logger.error({ err: error }, 'Error unlinking customer');
    return fail(res, 500, 'Error unlinking customer');
  }
};

// ─── Students ─────────────────────────────────────────────────────────

const studentsOf = async (family) => (await db.query(queries.selectFamilyStudents, [family.family_id])).rows.map(toStudent);

const addStudent = async (req, res) => {
  const { school, userId } = req.user;
  const studentId = String(req.body?.studentId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(studentId)) return fail(res, 400, 'studentId is required');
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const r = await attachStudent(db, family, studentId);
    if (!r.ok) return fail(res, r.status, r.body.message, r.body);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'student_add', studentId, actor: userId });
    return ok(res, { students: await studentsOf(family) });
  } catch (error) {
    logger.error({ err: error }, 'Error adding student to family');
    return fail(res, 500, 'Error adding student');
  }
};

const removeStudent = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const { rowCount } = await db.query(queries.deleteFamilyStudent, [family.family_id, req.params.studentId]);
    if (rowCount === 0) return fail(res, 404, 'Student is not in this family');
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'student_remove', studentId: req.params.studentId, actor: userId });
    return ok(res, { students: await studentsOf(family) });
  } catch (error) {
    logger.error({ err: error }, 'Error removing student from family');
    return fail(res, 500, 'Error removing student');
  }
};

// ─── Contacts ─────────────────────────────────────────────────────────

const contactsOf = async (family) => (await db.query(queries.selectFamilyContacts, [family.family_id])).rows.map(toContact);

async function setPrimary(familyId, contactId) {
  await db.query(queries.clearPrimaryContact, [familyId, contactId]);
  await db.query(queries.setPrimaryContact, [familyId, contactId]);
}

const addContact = async (req, res) => {
  const { school, userId } = req.user;
  const v = validateContact(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const c = v.value;
    const { rows } = await db.query(queries.insertContact, [family.family_id, c.name || null, c.email || null, c.phone || null, c.relation || null, 'manual']);
    if (c.isPrimary && rows[0]) await setPrimary(family.family_id, rows[0].contact_id);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'contact_add', details: { contactId: rows[0]?.contact_id, email: c.email || null }, actor: userId });
    return ok(res, { contacts: await contactsOf(family) }, 201);
  } catch (error) {
    if (error?.code === '23505') return fail(res, 409, 'A contact with that email already exists on this family');
    logger.error({ err: error }, 'Error adding contact');
    return fail(res, 500, 'Error adding contact');
  }
};

const updateContact = async (req, res) => {
  const { school, userId } = req.user;
  const v = validateContact(req.body || {}, { partial: true });
  if (v.error) return fail(res, 400, v.error);
  if (Object.keys(v.value).length === 0) return fail(res, 400, 'Nothing to update');
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const { rows: cur } = await db.query(queries.selectContact, [family.family_id, req.params.contactId]);
    const existing = cur[0];
    if (!existing) return fail(res, 404, 'Contact not found');
    const merged = {
      name: v.value.name !== undefined ? v.value.name : existing.name ?? null,
      email: v.value.email !== undefined ? v.value.email : existing.email ?? null,
      phone: v.value.phone !== undefined ? v.value.phone : existing.phone ?? null,
      relation: v.value.relation !== undefined ? v.value.relation : existing.relation ?? null,
    };
    if (!merged.name && !merged.email) return fail(res, 400, 'A contact needs a name or an email');
    const { rowCount } = await db.query(queries.updateContact, [family.family_id, req.params.contactId, merged.name, merged.email, merged.phone, merged.relation]);
    if (rowCount === 0) return fail(res, 404, 'Contact not found');
    if (v.value.isPrimary === true) await setPrimary(family.family_id, req.params.contactId);
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'contact_update', details: { contactId: req.params.contactId, changed: Object.keys(v.value) }, actor: userId });
    return ok(res, { contacts: await contactsOf(family) });
  } catch (error) {
    if (error?.code === '23505') return fail(res, 409, 'A contact with that email already exists on this family');
    logger.error({ err: error }, 'Error updating contact');
    return fail(res, 500, 'Error updating contact');
  }
};

const removeContact = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const family = await loadFamily(req, res);
    if (!family) return undefined;
    const { rowCount } = await db.query(queries.deleteContact, [family.family_id, req.params.contactId]);
    if (rowCount === 0) return fail(res, 404, 'Contact not found');
    await audit(db, { school, yearId: family.school_year_id, familyId: family.family_id, familyName: family.name, action: 'contact_remove', details: { contactId: req.params.contactId }, actor: userId });
    return ok(res, { contacts: await contactsOf(family) });
  } catch (error) {
    logger.error({ err: error }, 'Error removing contact');
    return fail(res, 500, 'Error removing contact');
  }
};

// ─── Invoice kind override ────────────────────────────────────────────

const setInvoiceKind = async (req, res) => {
  const { school, userId } = req.user;
  const kind = req.body?.kind ?? null;
  if (kind !== null && !KINDS.has(kind)) return fail(res, 400, 'kind must be parent, subsidy_grant, subsidy_school, other or null');
  try {
    const { rows } = await db.query(queries.setInvoiceKindOverride, [school, req.params.qboId, kind, userId]);
    if (!rows[0]) return fail(res, 404, 'Invoice not found');
    const inv = rows[0];
    // The family whose link covered the invoice's date (not the customer's current family) owns the audit entry.
    let owner = null;
    if (req.schoolYear) {
      const { rows: links } = await db.query(queries.selectFamilyLinksByYear, [school, req.schoolYear.schoolYearId]);
      const familyId = buildLinkIndex(links).familyFor(inv.customer_qbo_id, dateStr(inv.txn_date));
      if (familyId) {
        const { rows: fam } = await db.query(queries.selectFamilyById, [school, familyId]);
        owner = fam[0] || null;
      }
    }
    await audit(db, { school, yearId: req.schoolYear?.schoolYearId ?? null, familyId: owner?.family_id ?? null, familyName: owner?.name ?? `Customer ${inv.customer_qbo_id}`,
      action: 'invoice_kind_override', invoiceId: inv.qbo_id, details: { kindAuto: inv.kind_auto, kindOverride: inv.kind_override }, actor: userId });
    return ok(res, { qboId: inv.qbo_id, kindAuto: inv.kind_auto, kindOverride: inv.kind_override, kind: inv.kind });
  } catch (error) {
    logger.error({ err: error }, 'Error overriding invoice kind');
    return fail(res, 500, 'Error overriding invoice kind');
  }
};

// ─── Customer picker ──────────────────────────────────────────────────

async function yearWindow(req) {
  const { rows } = await db.query(schoolYearQueries.selectYearById, [req.schoolYear.schoolYearId]);
  return { year: rows[0], ...monthWindow(rows[0]) };
}

const searchCustomers = async (req, res) => {
  try {
    if (!req.schoolYear) return fail(res, 400, 'No school year configured for your school');
    const { from, to } = await yearWindow(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    const pattern = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await db.query(queries.searchCustomers, [
      req.user.school, pattern, String(req.query.unlinkedOnly) === 'true', String(req.query.withInvoices) === 'true', from, to, req.schoolYear.schoolYearId,
    ]);
    return ok(res, { customers: rows.map((c) => ({
      qboId: c.qbo_id, displayName: c.display_name, fullyQualifiedName: c.fully_qualified_name ?? null, isSubCustomer: Boolean(c.is_sub_customer),
      parentQboId: c.parent_qbo_id ?? null, active: c.active !== false, emails: c.emails || [],
      linkedFamilyId: c.linked_family_id ?? null, linkedFamilyName: c.linked_family_name ?? null,
      invoiceCount: Number(c.invoice_count) || 0, invoiceTotal: num(c.invoice_total) ?? 0, openBalance: num(c.open_balance) ?? 0,
      earliestInvoiceDate: c.earliest_invoice_date ? dateStr(c.earliest_invoice_date) : null,
    })) });
  } catch (error) {
    logger.error({ err: error }, 'Error searching QuickBooks customers');
    return fail(res, 500, 'Error searching customers');
  }
};

// ─── Suggestions ──────────────────────────────────────────────────────

/** Families with their contacts/students in the shape the suggestion engine wants. */
async function familiesForSuggestions(school, yearId) {
  const { families, studentsBy, contactsBy, linkIndex } = await loadFamilyYear(db, school, yearId);
  const shaped = families.map((f) => ({ ...f, students: studentsBy.get(f.family_id) || [], contacts: contactsBy.get(f.family_id) || [], current: linkIndex.currentFor(f.family_id) }));
  return { families: shaped, linkIndex };
}

const getSuggestions = async (req, res) => {
  try {
    if (!req.schoolYear) return fail(res, 400, 'No school year configured for your school');
    const school = req.user.school;
    const yearId = req.schoolYear.schoolYearId;
    const { from, to } = await yearWindow(req);
    const [{ families, linkIndex }, customers, invoices, orphans] = await Promise.all([
      familiesForSuggestions(school, yearId),
      db.query(queries.selectCustomerSummaries, [school]).then((r) => r.rows),
      db.query(queries.selectInvoicesInWindow, [school, from, to]).then((r) => r.rows),
      db.query(queries.selectStudentsWithoutFamily, [school, yearId]).then((r) => r.rows),
    ]);
    const linkedCustomerIds = new Set(families.map((f) => f.current?.customerId).filter(Boolean));
    const unlinkedFamilies = suggestForFamilies(families.filter((f) => !f.current), customers, { linkedCustomerIds });

    // Customers with live invoices this year that no link claims.
    const byCustomer = new Map();
    for (const i of invoices) {
      if (i.deleted_at || i.is_voided) continue;
      if (linkIndex.familyFor(i.customer_qbo_id, dateStr(i.txn_date))) continue;
      const txnDate = dateStr(i.txn_date);
      const e = byCustomer.get(i.customer_qbo_id) || { invoiceCount: 0, invoiceTotal: 0, openBalance: 0, earliestInvoiceDate: txnDate };
      if (txnDate < e.earliestInvoiceDate) e.earliestInvoiceDate = txnDate;
      e.invoiceCount += 1; e.invoiceTotal += num(i.total_amt); e.openBalance += num(i.balance);
      byCustomer.set(i.customer_qbo_id, e);
    }
    const customerById = new Map(customers.map((c) => [c.qbo_id, c]));
    const unlinkedRows = [...byCustomer.keys()].map((id) => customerById.get(id) || { qbo_id: id, display_name: `Customer ${id}`, emails: [], active: true });
    const unlinkedCustomers = suggestForCustomers(unlinkedRows, families).map((c) => {
      const agg = byCustomer.get(c.qboId);
      return { ...c, invoiceCount: agg.invoiceCount, invoiceTotal: round2(agg.invoiceTotal), openBalance: round2(agg.openBalance), earliestInvoiceDate: agg.earliestInvoiceDate };
    }).sort((a, b) => b.invoiceTotal - a.invoiceTotal || a.displayName.localeCompare(b.displayName));

    const studentsWithoutFamily = orphans.map((s) => {
      const hit = suggestFamilyForStudent(s, families);
      return { studentId: s.student_id, name: s.name, grade: s.grade, motherEmail: s.mother_email ?? null, fatherEmail: s.father_email ?? null, suggestedFamilyId: hit?.familyId ?? null, suggestedFamilyName: hit?.name ?? null };
    });

    return ok(res, { unlinkedFamilies, unlinkedCustomers, studentsWithoutFamily });
  } catch (error) {
    logger.error({ err: error }, 'Error building link suggestions');
    return fail(res, 500, 'Error building suggestions');
  }
};

// ─── Import ───────────────────────────────────────────────────────────

const importFamilies = async (req, res) => {
  const { school, userId } = req.user;
  if (!req.schoolYear) return fail(res, 400, 'No school year configured for your school');
  const yearId = req.schoolYear.schoolYearId;
  const body = req.body || {};
  if (!body.roster || typeof body.roster !== 'object' || !Array.isArray(body.roster.families)) return fail(res, 400, 'roster must be the parsed roster JSON ({ families: [...] })');
  if (typeof body.customerMap !== 'string' || !body.customerMap.trim()) return fail(res, 400, 'customerMap must be the CSV text');
  const dryRun = body.dryRun === undefined ? true : Boolean(body.dryRun);
  const acceptNear = body.acceptNear && typeof body.acceptNear === 'object' ? body.acceptNear : {};

  try {
    const [students, existingFamilies, assignments, conn] = await Promise.all([
      db.query(queries.selectStudentsForSeed, [school, yearId]).then((r) => r.rows),
      db.query(queries.selectFamiliesWithCurrentCustomer, [school, yearId]).then((r) => r.rows),
      db.query(queries.selectAssignmentsByYear, [school, yearId]).then((r) => r.rows),
      db.query(queries.selectConnection, [school]).then((r) => r.rows[0]),
    ]);
    const existingAssignments = Object.fromEntries(assignments.map((r) => [r.student_id, r.family_id]));
    const plan = planSeed({ roster: body.roster, customerMap: body.customerMap, students, existingFamilies, existingAssignments, acceptNear });

    // A customer already billing a family that is not part of this roster would
    // make the write fail half-way; say so up front, naming the family.
    const { rows: openLinks } = await db.query(queries.selectOpenLinksByYear, [school, yearId]);
    const heldBy = new Map(openLinks.map((l) => [l.qbo_customer_id, l]));
    // Families in this roster may swap customers among themselves; the seeder
    // removes every changing link before opening new ones.
    const rosterFamilyIds = new Set(plan.families.map((f) => f.existingFamilyId).filter(Boolean));
    for (const f of plan.families) {
      const held = heldBy.get(f.customerId);
      if (held && !rosterFamilyIds.has(held.family_id)) {
        plan.errors.push(`customer ${f.customerId} (roster family ${f.familyNo}) is already linked to the family "${held.family_name}", which is not in this roster`);
      }
    }
    if (plan.errors.length) return res.status(422).json({ status: 'failed', message: 'The mapping has errors', data: { applied: false, plan, summary: null } });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const summary = await applySeed(client, { school, schoolYearId: yearId, actorUserId: userId, plan, backfillSince: resolveSettings(conn?.settings || {}).backfillSince });
      if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
      return ok(res, { applied: !dryRun, plan, summary });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error?.code === '23505') return uniqueViolation(res, error);
    logger.error({ err: error }, 'Error importing families');
    return fail(res, 500, 'Error importing families');
  }
};

module.exports = {
  listFamilies, createFamily, updateFamily, deleteFamily,
  linkCustomer, unlinkCustomer,
  addStudent, removeStudent,
  addContact, updateContact, removeContact,
  setInvoiceKind, searchCustomers, getSuggestions, importFamilies,
  loadFamilySummaries,
};
