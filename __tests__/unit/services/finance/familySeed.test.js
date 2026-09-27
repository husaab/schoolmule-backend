const { planSeed, applySeed, parseCustomerMap } = require('../../../../services/finance/familySeed');
const db = require('../../../__mocks__/config/database');

const child = (name, grade, over = {}) => ({ name, grade, grade_label: `Grade ${grade}`, rate: 500, subsidy: 0, subsidy_source: 'al-maarif', staff_discount: 0, teacher: null, tuition_waived: false, master_no: 1, parent_monthly: 500, ...over });
const rosterFamily = (over = {}) => ({
  family_no: 24, primary_parent: 'Amal Haddad', parents: ['Amal Haddad', 'Karim Haddad'],
  emails: ['karim.haddad@example.com', 'amal.haddad@example.com'], address: '1 Main St',
  children: [child('Lina Haddad', '4'), child('Nour Haddad', '7')],
  registration_fee_total: 400, registration_note: null, monthly_parent_total: 1000, monthly_subsidy_total: 0,
  september_parent_total: 1400, september_subsidy_total: 0, is_subsidy: false, is_teacher: false, ...over,
});
const mapRow = (over = {}) => ({ family_no: '24', status: 'FIXED', primary_parent: 'Amal Haddad', final_id: '27', note: 'Sept 2026 invoice already sent on this customer - keep', ...over });
const student = (id, name, grade, over = {}) => ({ student_id: id, name, grade, mother_name: 'Amal Haddad', mother_email: 'amal.haddad@example.com', mother_number: '416-555-0100', father_name: 'Karim Haddad', father_email: 'karim.haddad@example.com', father_number: null, ...over });

const plan = (over = {}) => planSeed({
  roster: { families: [rosterFamily()] },
  customerMap: [mapRow()],
  students: [student('s1', 'Lina Haddad', '4'), student('s2', 'Nour Haddad', '7')],
  ...over,
});

describe('parseCustomerMap', () => {
  it('parses the quoted CSV the mapping script wrote', () => {
    const csv = 'family_no,status,primary_parent,all_parents,children,emails,chosen_id,chosen_name,chosen_balance,final_id,other_parent_candidates,child_records,email_only_matches,note\n'
      + '24,FIXED,Amal Haddad,Amal Haddad / Karim Haddad,Lina Haddad (4); Nour Haddad (7),"karim.haddad@example.com, amal.haddad@example.com",27,Amal Haddad Karam,1000.00,27,172:Amal Haddad[$0],786:Lina Haddad[$0],,Sept 2026 invoice already sent on this customer - keep\n'
      + '1,NEW,Bilal Mansour,Bilal Mansour,Hana Mansour (JK),bilal.mansour@example.com,991,Bilal Mansour,0.00,991,,,,"create customer, then link"\n';
    const rows = parseCustomerMap(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ family_no: '24', status: 'FIXED', final_id: '27', emails: 'karim.haddad@example.com, amal.haddad@example.com' });
    expect(rows[1].note).toBe('create customer, then link');
  });
});

describe('planSeed', () => {
  it('links exact name+grade matches and builds de-duplicated contacts from the student records', () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.counts).toMatchObject({ families: 1, exact: 2, near: 0, unmatched: 0 });
    const f = p.families[0];
    expect(f).toMatchObject({ familyNo: 24, action: 'create', customerId: '27' });
    expect(f.row).toMatchObject({ name: 'Amal Haddad', is_subsidy: false, is_teacher: false, expected_monthly_parent: 1000, expected_monthly_subsidy: 0, roster_family_no: 24, notes: '[FIXED] Sept 2026 invoice already sent on this customer - keep' });
    expect(f.students.map((s) => [s.studentId, s.tier])).toEqual([['s1', 'exact'], ['s2', 'exact']]);
    // Two siblings share the same parents → two contacts, not four.
    expect(f.contacts).toEqual([
      { name: 'Amal Haddad', email: 'amal.haddad@example.com', phone: '416-555-0100', relation: 'mother', is_primary: true, source: 'student_record' },
      { name: 'Karim Haddad', email: 'karim.haddad@example.com', phone: null, relation: 'father', is_primary: false, source: 'student_record' },
    ]);
  });

  it('never zips roster parents with roster emails by position', () => {
    const p = plan({
      roster: { families: [rosterFamily({ parents: ['Amina Ali', 'Bilal Ali'], emails: ['bilal@x.com', 'amina@x.com'], primary_parent: 'Amina Ali' })] },
      students: [student('s1', 'Lina Haddad', '4', { mother_name: null, mother_email: null, mother_number: null, father_name: null, father_email: null }), student('s2', 'Nour Haddad', '7', { mother_name: null, mother_email: null, father_name: null, father_email: null })],
    });
    const contacts = p.families[0].contacts;
    expect(contacts.find((c) => c.name === 'Amina Ali' && c.email === 'bilal@x.com')).toBeUndefined();
    expect(contacts.find((c) => c.name === 'Bilal Ali' && c.email === 'amina@x.com')).toBeUndefined();
    expect(contacts.filter((c) => c.email).map((c) => c.email).sort()).toEqual(['amina@x.com', 'bilal@x.com']);
    expect(contacts.filter((c) => c.name).map((c) => c.name).sort()).toEqual(['Amina Ali', 'Bilal Ali']);
    expect(contacts.filter((c) => c.is_primary)).toHaveLength(1);
    expect(contacts.find((c) => c.is_primary).name).toBe('Amina Ali');
    expect(contacts.every((c) => c.source === 'roster')).toBe(true);
  });

  it('pairs the one remaining name with the one remaining email', () => {
    const p = plan({
      roster: { families: [rosterFamily({ parents: ['Amal Haddad', 'Karim Haddad'], emails: ['amal.haddad@example.com', 'other@x.com'] })] },
      students: [student('s1', 'Lina Haddad', '4', { father_name: null, father_email: null }), student('s2', 'Nour Haddad', '7', { father_name: null, father_email: null })],
    });
    expect(p.families[0].contacts).toContainEqual(expect.objectContaining({ name: 'Karim Haddad', email: 'other@x.com', relation: 'guardian', source: 'roster' }));
  });

  it('reports near matches with candidates and only links them when accepted', () => {
    const p = plan({ students: [student('s1', 'Lina Haddad', '5'), student('s2', 'Nour Haddad', '7')] });
    expect(p.counts).toMatchObject({ exact: 1, near: 1 });
    expect(p.near).toEqual([{ familyNo: 24, child: 'Lina Haddad', grade: '4', candidates: [{ studentId: 's1', name: 'Lina Haddad', grade: '5' }] }]);
    expect(p.families[0].students.map((s) => s.studentId)).toEqual(['s2']);

    const accepted = plan({ students: [student('s1', 'Lina Haddad', '5'), student('s2', 'Nour Haddad', '7')], acceptNear: { '24:Lina Haddad': 's1' } });
    expect(accepted.families[0].students.map((s) => [s.studentId, s.tier])).toEqual([['s1', 'near-accepted'], ['s2', 'exact']]);
    expect(accepted.near).toEqual([]);
  });

  it('reports unmatched children and students already in another family', () => {
    const p = plan({
      students: [student('s2', 'Nour Haddad', '7')],
      existingAssignments: { s2: 'other-family' },
    });
    expect(p.unmatched).toEqual([{ familyNo: 24, child: 'Lina Haddad', grade: '4' }]);
    expect(p.conflicts).toEqual([{ familyNo: 24, child: 'Nour Haddad', studentId: 's2', familyId: 'other-family' }]);
    expect(p.families[0].students).toEqual([]);
  });

  it('fails on a missing map row or a customer id used twice', () => {
    const two = [rosterFamily(), rosterFamily({ family_no: 25, primary_parent: 'Rania Saleh', children: [child('Omar Saleh', '4')] })];
    expect(planSeed({ roster: { families: two }, customerMap: [mapRow()], students: [] }).errors).toContainEqual(expect.stringMatching(/family 25.*no customer-map row/i));
    expect(planSeed({ roster: { families: two }, customerMap: [mapRow(), mapRow({ family_no: '25', final_id: '27' })], students: [] }).errors).toContainEqual(expect.stringMatching(/customer 27.*families 24.*25/i));
    expect(planSeed({ roster: { families: [rosterFamily()] }, customerMap: [mapRow({ final_id: 'abc' })], students: [] }).errors).toContainEqual(expect.stringMatching(/final_id/));
  });

  it('marks an existing family as an update and notes a changed customer', () => {
    const p = plan({ existingFamilies: [{ family_id: 'f-24', roster_family_no: 24, qbo_customer_id: '172' }] });
    expect(p.families[0]).toMatchObject({ action: 'update', existingFamilyId: 'f-24', customerId: '27', previousCustomerId: '172' });
  });

  it('carries subsidy and teacher flags and the expected monthly amounts', () => {
    const p = plan({ roster: { families: [rosterFamily({ is_subsidy: true, monthly_parent_total: 500, monthly_subsidy_total: 500 })] } });
    expect(p.families[0].row).toMatchObject({ is_subsidy: true, expected_monthly_parent: 500, expected_monthly_subsidy: 500 });
  });
});

describe('applySeed', () => {
  const calls = () => db._mockClient.query.mock.calls;

  beforeEach(() => {
    db._mockClient.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO families/.test(sql)) return { rows: [{ family_id: 'f-new', name: params[2] }] };
      if (/SELECT .*FROM family_customer_links/.test(sql)) return { rows: [] };
      if (/INSERT INTO family_students/.test(sql)) return { rows: [{ student_id: params[1] }], rowCount: 1 };
      if (/INSERT INTO family_contacts/.test(sql)) return { rows: [{ contact_id: 'c' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  it('writes the family, its link, students, contacts and one audit row', async () => {
    const p = plan();
    const summary = await applySeed(db._mockClient, { school: 'ALHAADIACADEMY', schoolYearId: 'y1', actorUserId: 'u1', plan: p, backfillSince: '2026-08-01' });

    expect(summary).toMatchObject({ familiesCreated: 1, familiesUpdated: 0, studentsLinked: 2, contactsWritten: 2, linksOpened: 1 });
    const sqls = calls().map((c) => c[0]);
    const fam = calls().find(([s]) => /INSERT INTO families/.test(s));
    expect(fam[0]).toMatch(/ON CONFLICT \(school, school_year_id, roster_family_no\) WHERE roster_family_no IS NOT NULL DO UPDATE/);
    expect(fam[1].slice(0, 3)).toEqual(['ALHAADIACADEMY', 'y1', 'Amal Haddad']);

    const link = calls().find(([s]) => /INSERT INTO family_customer_links/.test(s));
    expect(link[1]).toEqual(['ALHAADIACADEMY', 'f-new', '27', '2026-08-01', 'u1']);

    const studentInserts = calls().filter(([s]) => /INSERT INTO family_students/.test(s));
    expect(studentInserts).toHaveLength(2);
    // Same-school, same-year guard is in the SQL itself.
    expect(studentInserts[0][0]).toMatch(/JOIN families f ON f\.family_id = \$1[\s\S]*s\.school = f\.school AND s\.school_year_id = f\.school_year_id/);

    const contactInserts = calls().filter(([s]) => /INSERT INTO family_contacts/.test(s));
    expect(contactInserts).toHaveLength(2);
    // The partial unique index is checked row by row, so the primary flag moves in two statements.
    expect(calls().some(([s]) => /is_primary = false/.test(s))).toBe(true);
    expect(calls().some(([s]) => /is_primary = true/.test(s))).toBe(true);
    expect(contactInserts[0][0]).toMatch(/ON CONFLICT \(family_id, lower\(email\)\) WHERE email IS NOT NULL DO UPDATE/);

    const audit = calls().find(([s]) => /INSERT INTO family_link_audit/.test(s));
    expect(audit[1]).toEqual(expect.arrayContaining(['seed', '27', 'u1']));
    expect(sqls.some((s) => /BEGIN|COMMIT/.test(s))).toBe(false); // the caller owns the transaction
  });

  it('closes the old link and opens a new one when the customer changed', async () => {
    db._mockClient.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO families/.test(sql)) return { rows: [{ family_id: 'f-24' }] };
      if (/SELECT .*FROM family_customer_links/.test(sql)) return { rows: [{ link_id: 'old', qbo_customer_id: '172' }] };
      if (/INSERT INTO family_students/.test(sql)) return { rows: [{ student_id: params[1] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const p = plan({ existingFamilies: [{ family_id: 'f-24', roster_family_no: 24, qbo_customer_id: '172' }] });
    const summary = await applySeed(db._mockClient, { school: 'ALHAADIACADEMY', schoolYearId: 'y1', actorUserId: 'u1', plan: p, backfillSince: '2026-08-01' });
    expect(summary).toMatchObject({ familiesUpdated: 1, linksOpened: 1, linksClosed: 1 });
    // A wrong mapping is removed outright: a zero-length range would still claim invoices dated that day.
    const close = calls().find(([s]) => /DELETE FROM family_customer_links/.test(s));
    expect(close[1]).toContain('old');
    const audit = calls().find(([s]) => /INSERT INTO family_link_audit/.test(s));
    expect(audit[1]).toEqual(expect.arrayContaining(['172', '27']));
  });

  it('removes every changed link before opening new ones, so two families can swap customers', async () => {
    db._mockClient.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO families/.test(sql)) return { rows: [{ family_id: params[8] === 24 ? 'f-24' : 'f-25' }] };
      if (/SELECT .*FROM family_customer_links/.test(sql)) return { rows: [{ link_id: `old-${params[0]}`, qbo_customer_id: params[0] === 'f-24' ? '172' : '27' }] };
      return { rows: [], rowCount: 1 };
    });
    const two = [rosterFamily(), rosterFamily({ family_no: 25, primary_parent: 'Other Parent', children: [child('Sami Other', '3')] })];
    const p = planSeed({ roster: { families: two }, customerMap: [mapRow(), mapRow({ family_no: '25', final_id: '172', primary_parent: 'Other Parent' })], students: [],
      existingFamilies: [{ family_id: 'f-24', roster_family_no: 24, qbo_customer_id: '172' }, { family_id: 'f-25', roster_family_no: 25, qbo_customer_id: '27' }] });
    const summary = await applySeed(db._mockClient, { school: 'ALHAADIACADEMY', schoolYearId: 'y1', actorUserId: 'u1', plan: p, backfillSince: '2026-08-01' });
    expect(summary).toMatchObject({ linksClosed: 2, linksOpened: 2 });
    const sqls = calls().map(([s]) => s);
    const lastDelete = sqls.map((s, i) => (/DELETE FROM family_customer_links/.test(s) ? i : -1)).filter((i) => i >= 0).pop();
    const firstOpen = sqls.findIndex((s) => /INSERT INTO family_customer_links/.test(s));
    expect(lastDelete).toBeLessThan(firstOpen);
  });

  it('reports a student that another family already holds instead of silently skipping', async () => {
    db._mockClient.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO families/.test(sql)) return { rows: [{ family_id: 'f-new' }] };
      if (/INSERT INTO family_students/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT family_id FROM family_students/.test(sql)) return { rows: [{ family_id: 'someone-else' }] };
      return { rows: [], rowCount: 1 };
    });
    const summary = await applySeed(db._mockClient, { school: 'ALHAADIACADEMY', schoolYearId: 'y1', actorUserId: 'u1', plan: plan(), backfillSince: '2026-08-01' });
    expect(summary.studentsLinked).toBe(0);
    expect(summary.conflicts).toEqual([
      { familyNo: 24, studentId: 's1', familyId: 'someone-else' },
      { familyNo: 24, studentId: 's2', familyId: 'someone-else' },
    ]);
  });
});
