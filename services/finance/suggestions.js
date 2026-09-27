// services/finance/suggestions.js
//
// Who probably belongs to whom. Used by the linking wizard to rank candidates
// for an unlinked family (which QBO customer?) and an unlinked customer with
// invoices (which family?). Pure and DB-free.
//
// Ranking, strongest first:
//   email    a contact/guardian email equals a customer email (case-insensitive)
//   name     the customer's display name is the family name, a reordering or
//            a near variant of it, or shares its surname
//   student  the customer is a child-named record matching one of the students
// Never a decision — always a suggestion the admin confirms.

const { normalizeName, isNearName, nameTokens } = require('../import/matching');

// A child-named record matching a student outranks a shared surname: it is the
// stronger clue in a book where many families share a surname.
const SCORE = { email: 100, exactName: 80, exactStudent: 70, nearName: 65, nearStudent: 55, surname: 50 };
const MAX_CANDIDATES = 5;

const lower = (s) => String(s || '').trim().toLowerCase();
const emailsOf = (family) => new Set((family.contacts || []).map((c) => lower(c.email)).filter(Boolean));
const customerEmails = (c) => new Set((c.emails || []).map(lower).filter(Boolean));
const surname = (name) => { const t = [...nameTokens(name)]; return t.length ? t[t.length - 1] : null; };

function nameScore(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return SCORE.exactName;
  if (isNearName(a, b)) return SCORE.nearName;
  const sa = surname(a);
  const sb = surname(b);
  if (sa && sb && sa === sb && sa.length > 2) return SCORE.surname;
  return 0;
}

function studentScore(customerName, students) {
  let best = 0;
  const target = normalizeName(customerName);
  for (const s of students || []) {
    const n = normalizeName(s.name);
    if (!n) continue;
    if (n === target) return SCORE.exactStudent;
    if (isNearName(customerName, s.name)) best = Math.max(best, SCORE.nearStudent);
  }
  return best;
}

/** Best (score, reason) for a family ↔ customer pair, or null. */
function match(family, customer) {
  const fEmails = emailsOf(family);
  const cEmails = customerEmails(customer);
  let best = null;
  const consider = (score, reason) => { if (score > 0 && (!best || score > best.score)) best = { score, reason }; };
  for (const e of cEmails) if (fEmails.has(e)) { consider(SCORE.email, 'email'); break; }
  consider(nameScore(family.name, customer.display_name), 'name');
  consider(studentScore(customer.display_name, family.students), 'student');
  return best;
}

const shapeCustomer = (c) => ({ qboId: c.qbo_id, displayName: c.display_name, isSubCustomer: Boolean(c.is_sub_customer), active: c.active !== false });

/**
 * @param {Array} families   [{ family_id, name, contacts:[{email,name}], students:[{name}] }]
 * @param {Array} customers  cached customer rows
 * @param {object} [opts]    linkedCustomerIds: Set of customer ids already open-linked (excluded)
 */
function suggestForFamilies(families, customers, { linkedCustomerIds = new Set() } = {}) {
  const pool = customers.filter((c) => !linkedCustomerIds.has(c.qbo_id) && !c.deleted_at);
  return families.map((f) => {
    const candidates = [];
    for (const c of pool) {
      const m = match(f, c);
      if (m) candidates.push({ ...shapeCustomer(c), reason: m.reason, score: m.score });
    }
    candidates.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
    return { familyId: f.family_id, name: f.name, candidates: candidates.slice(0, MAX_CANDIDATES) };
  });
}

/**
 * @param {Array} customers  unlinked customers (with invoices), cached rows
 * @param {Array} families   families (same shape as above); pass all, linked or not
 */
function suggestForCustomers(customers, families, { linkedFamilyIds = new Set() } = {}) {
  const pool = families.filter((f) => !linkedFamilyIds.has(f.family_id));
  return customers.map((c) => {
    const candidates = [];
    for (const f of pool) {
      const m = match(f, c);
      if (m) candidates.push({ familyId: f.family_id, name: f.name, reason: m.reason, score: m.score });
    }
    candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { ...shapeCustomer(c), candidates: candidates.slice(0, MAX_CANDIDATES) };
  });
}

/** The family whose contact email matches a guardian email on the student record, or null. */
function suggestFamilyForStudent(student, families) {
  const emails = [lower(student.mother_email), lower(student.father_email)].filter(Boolean);
  if (emails.length === 0) return null;
  for (const f of families) {
    const fe = emailsOf(f);
    if (emails.some((e) => fe.has(e))) return { familyId: f.family_id, name: f.name };
  }
  return null;
}

module.exports = { suggestForFamilies, suggestForCustomers, suggestFamilyForStudent, SCORE };
