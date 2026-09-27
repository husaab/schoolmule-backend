// services/finance/familySeed.js
//
// Loads the 2026-27 billing roster (roster-2026-2027.json) and its
// family → QBO customer map (customer-map-2026-2027.csv) into the family
// tables. Two halves:
//
//   planSeed   pure — matches roster children to student rows, decides which
//              families to create/update, builds contacts, reports anything
//              that needs a human (near matches, unmatched, conflicts).
//   applySeed  writes one plan inside the caller's transaction, idempotently
//              (natural keys everywhere, so re-running is a no-op).
//
// Matching reuses the registration importer's name normalization. Only exact
// name+grade matches are linked automatically; the roster's `parents[]` and
// `emails[]` arrays are NOT index-aligned, so contacts are built from the
// student records first and roster emails are never zipped to names.

const { buildCandidateIndex, resolveMatch, normalizeName } = require('../import/matching');
const queries = require('../../queries/finance.queries');

const ID_RE = /^\d+$/;

// ─── CSV ──────────────────────────────────────────────────────────────

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

/** The customer map as objects keyed by its header row. */
function parseCustomerMap(csvText) {
  const [header, ...body] = parseCsv(csvText);
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])));
}

// ─── Plan ─────────────────────────────────────────────────────────────

const lower = (s) => String(s || '').trim().toLowerCase();
const orNull = (s) => { const v = String(s ?? '').trim(); return v === '' ? null : v; };

function buildContacts(family, matchedStudents) {
  const contacts = [];
  const byEmail = new Map();
  const byName = new Map();
  const add = (c) => {
    const emailKey = c.email ? lower(c.email) : null;
    const nameKey = c.name ? normalizeName(c.name) : null;
    if (emailKey && byEmail.has(emailKey)) {
      const existing = byEmail.get(emailKey);
      existing.name = existing.name || c.name;
      existing.phone = existing.phone || c.phone;
      existing.relation = existing.relation || c.relation;
      if (nameKey) byName.set(nameKey, existing);
      return;
    }
    if (!emailKey && nameKey && byName.has(nameKey)) return;
    const contact = { name: c.name || null, email: c.email || null, phone: c.phone || null, relation: c.relation || null, is_primary: false, source: c.source };
    contacts.push(contact);
    if (emailKey) byEmail.set(emailKey, contact);
    if (nameKey) byName.set(nameKey, contact);
  };

  // (a) the student records: name, email, phone and relation are all known.
  for (const s of matchedStudents) {
    if (orNull(s.mother_name) || orNull(s.mother_email)) add({ name: orNull(s.mother_name), email: orNull(s.mother_email), phone: orNull(s.mother_number), relation: 'mother', source: 'student_record' });
    if (orNull(s.father_name) || orNull(s.father_email)) add({ name: orNull(s.father_name), email: orNull(s.father_email), phone: orNull(s.father_number), relation: 'father', source: 'student_record' });
  }

  // (b) roster emails/names not yet placed. Pair only when there is exactly one of each.
  const unplacedEmails = (family.emails || []).map((e) => String(e).trim()).filter((e) => e && !byEmail.has(lower(e)));
  const unplacedNames = (family.parents || []).map((n) => String(n).trim()).filter((n) => n && !byName.has(normalizeName(n)));
  if (unplacedEmails.length === 1 && unplacedNames.length === 1) {
    add({ name: unplacedNames[0], email: unplacedEmails[0], relation: 'guardian', source: 'roster' });
  } else {
    for (const e of unplacedEmails) add({ email: e, source: 'roster' });
    for (const n of unplacedNames) add({ name: n, source: 'roster' });
  }

  // (c) one primary: the roster's primary parent, else the first contact.
  const primaryKey = normalizeName(family.primary_parent);
  const primary = contacts.find((c) => c.name && normalizeName(c.name) === primaryKey) || contacts[0];
  if (primary) primary.is_primary = true;
  return contacts;
}

/**
 * @param {object} p
 * @param {object} p.roster              parsed roster JSON ({ families: [...] })
 * @param {Array|string} p.customerMap   parsed map rows, or the CSV text
 * @param {Array} p.students             rows from selectStudentsForSeed
 * @param {Array} [p.existingFamilies]   rows from selectFamiliesWithCurrentCustomer
 * @param {object} [p.existingAssignments] student_id → family_id already holding it
 * @param {object} [p.acceptNear]        `${familyNo}:${childName}` → student_id to accept a near match
 */
function planSeed({ roster, customerMap, students, existingFamilies = [], existingAssignments = {}, acceptNear = {} }) {
  const errors = [];
  const near = [];
  const unmatched = [];
  const conflicts = [];
  const families = [];

  const mapRows = typeof customerMap === 'string' ? parseCustomerMap(customerMap) : customerMap;
  const mapByNo = new Map();
  for (const r of mapRows) mapByNo.set(Number(r.family_no), r);

  const rosterFamilies = roster?.families || [];
  const seenNos = new Set();
  for (const f of rosterFamilies) {
    if (seenNos.has(f.family_no)) errors.push(`family_no ${f.family_no} appears twice in the roster`);
    seenNos.add(f.family_no);
  }

  // A customer may bill only one family.
  const familiesByCustomer = new Map();
  for (const f of rosterFamilies) {
    const m = mapByNo.get(Number(f.family_no));
    if (!m) continue;
    const id = String(m.final_id || '').trim();
    if (!familiesByCustomer.has(id)) familiesByCustomer.set(id, []);
    familiesByCustomer.get(id).push(f.family_no);
  }
  for (const [id, nos] of familiesByCustomer) {
    if (nos.length > 1) errors.push(`customer ${id} is mapped to families ${nos.join(' and ')}`);
  }

  const existingByNo = new Map(existingFamilies.map((e) => [Number(e.roster_family_no), e]));
  const index = buildCandidateIndex(students, (s) => s.name);
  const usedStudents = new Map();
  let exact = 0;

  for (const f of rosterFamilies) {
    const m = mapByNo.get(Number(f.family_no));
    if (!m) { errors.push(`family ${f.family_no} (${f.primary_parent}) has no customer-map row`); continue; }
    const customerId = String(m.final_id || '').trim();
    if (!ID_RE.test(customerId)) { errors.push(`family ${f.family_no}: final_id "${m.final_id}" is not a QBO customer id`); continue; }

    const existing = existingByNo.get(Number(f.family_no)) || null;
    const matched = [];
    const matchedStudents = [];

    for (const child of f.children || []) {
      const grade = String(child.grade);
      const res = resolveMatch(index, { name: child.name, grade }, (s) => s.name, (s) => s.grade);
      let picked = null;
      let tier = null;
      if (res.tier === 'exact') { picked = res.matches[0]; tier = 'exact'; }
      else if (res.tier === 'near') {
        const acceptedId = acceptNear[`${f.family_no}:${child.name}`];
        const accepted = acceptedId && res.matches.find((s) => s.student_id === acceptedId);
        if (accepted) { picked = accepted; tier = 'near-accepted'; }
        else near.push({ familyNo: f.family_no, child: child.name, grade, candidates: res.matches.map((s) => ({ studentId: s.student_id, name: s.name, grade: s.grade })) });
      } else unmatched.push({ familyNo: f.family_no, child: child.name, grade });

      if (!picked) continue;
      const heldBy = existingAssignments[picked.student_id];
      if (heldBy && heldBy !== existing?.family_id) { conflicts.push({ familyNo: f.family_no, child: child.name, studentId: picked.student_id, familyId: heldBy }); continue; }
      if (usedStudents.has(picked.student_id)) { errors.push(`student ${picked.name} (${picked.student_id}) matched by families ${usedStudents.get(picked.student_id)} and ${f.family_no}`); continue; }
      usedStudents.set(picked.student_id, f.family_no);
      if (tier === 'exact') exact += 1;
      matched.push({ studentId: picked.student_id, name: picked.name, grade: picked.grade, tier });
      matchedStudents.push(picked);
    }

    const status = String(m.status || '').trim();
    const note = orNull(m.note);
    const notes = status && status !== 'AUTO' ? `[${status}]${note ? ` ${note}` : ''}` : note;

    families.push({
      familyNo: f.family_no,
      action: existing ? 'update' : 'create',
      existingFamilyId: existing?.family_id ?? null,
      customerId,
      previousCustomerId: existing && existing.qbo_customer_id && existing.qbo_customer_id !== customerId ? existing.qbo_customer_id : null,
      mapStatus: status || null,
      row: {
        name: f.primary_parent,
        is_subsidy: Boolean(f.is_subsidy),
        is_teacher: Boolean(f.is_teacher),
        expected_monthly_parent: Number(f.monthly_parent_total) || 0,
        expected_monthly_subsidy: Number(f.monthly_subsidy_total) || 0,
        notes,
        roster_family_no: f.family_no,
      },
      students: matched,
      contacts: buildContacts(f, matchedStudents),
    });
  }

  return {
    families, near, unmatched, conflicts, errors,
    counts: {
      families: families.length,
      exact,
      nearAccepted: families.reduce((n, f) => n + f.students.filter((s) => s.tier === 'near-accepted').length, 0),
      near: near.length,
      unmatched: unmatched.length,
      conflicts: conflicts.length,
      contacts: families.reduce((n, f) => n + f.contacts.length, 0),
    },
  };
}

// ─── Apply ────────────────────────────────────────────────────────────

/**
 * Writes a plan. The caller owns the transaction (BEGIN/COMMIT or ROLLBACK for a dry run).
 *
 * Links are handled in two passes — every stale link is removed before any new
 * one is opened — so two existing families that swapped customers do not trip
 * the one-open-link-per-customer index halfway through.
 */
async function applySeed(client, { school, schoolYearId, actorUserId = null, plan, backfillSince }) {
  if (plan.errors.length) throw new Error(`Seed plan has errors: ${plan.errors.join('; ')}`);

  const summary = { familiesCreated: 0, familiesUpdated: 0, studentsLinked: 0, contactsWritten: 0, linksOpened: 0, linksClosed: 0, conflicts: [], skipped: [] };

  // Pass 1: family rows, and which links must change.
  const work = [];
  for (const f of plan.families) {
    const r = f.row;
    const { rows } = await client.query(queries.upsertFamilyFromSeed, [
      school, schoolYearId, r.name, r.is_subsidy, r.is_teacher, r.expected_monthly_parent, r.expected_monthly_subsidy,
      r.notes, r.roster_family_no, actorUserId,
    ]);
    const familyId = rows[0].family_id;
    if (f.action === 'create') summary.familiesCreated += 1; else summary.familiesUpdated += 1;

    const { rows: open } = await client.query(queries.selectOpenLinkForFamily, [familyId]);
    const current = open[0] || null;
    const changed = !current || current.qbo_customer_id !== f.customerId;
    work.push({ f, familyId, staleLink: current && changed ? current : null, needsLink: changed });
  }

  // Pass 2: remove every wrong link, then open the new ones.
  for (const w of work) {
    if (w.staleLink) {
      await client.query(queries.deleteLink, [w.staleLink.link_id]);
      summary.linksClosed += 1;
    }
  }
  for (const w of work) {
    if (w.needsLink) {
      await client.query(queries.openLink, [school, w.familyId, w.f.customerId, backfillSince, actorUserId]);
      summary.linksOpened += 1;
    }
  }

  // Pass 3: students, contacts, audit.
  for (const { f, familyId, staleLink } of work) {
    for (const s of f.students) {
      const { rowCount } = await client.query(queries.insertFamilyStudent, [familyId, s.studentId]);
      if (rowCount > 0) { summary.studentsLinked += 1; continue; }
      const { rows: holder } = await client.query(queries.selectFamilyOfStudent, [s.studentId]);
      if (holder[0] && holder[0].family_id !== familyId) summary.conflicts.push({ familyNo: f.familyNo, studentId: s.studentId, familyId: holder[0].family_id });
      else if (!holder[0]) summary.skipped.push({ familyNo: f.familyNo, studentId: s.studentId, reason: 'not in this school year' });
      // else: already in this family — idempotent re-run
    }

    let primaryId = null;
    for (const c of f.contacts) {
      const res = c.email
        ? await client.query(queries.upsertContactByEmail, [familyId, c.name, c.email, c.phone, c.relation, c.source])
        : await client.query(queries.insertContactNameOnly, [familyId, c.name, c.phone, c.relation, c.source]);
      if (res.rowCount > 0) summary.contactsWritten += 1;
      if (c.is_primary && res.rows[0]) primaryId = res.rows[0].contact_id;
    }
    if (primaryId) {
      await client.query(queries.clearPrimaryContact, [familyId, primaryId]);
      await client.query(queries.setPrimaryContact, [familyId, primaryId]);
    }

    await client.query(queries.insertAudit, [
      school, schoolYearId, familyId, f.row.name, 'seed', staleLink ? staleLink.qbo_customer_id : null, f.customerId, null, null,
      JSON.stringify({ mapStatus: f.mapStatus, action: f.action, students: f.students.map((s) => ({ studentId: s.studentId, tier: s.tier })), contacts: f.contacts.length }),
      actorUserId,
    ]);
  }

  return summary;
}

module.exports = { planSeed, applySeed, parseCustomerMap, parseCsv, buildContacts };
