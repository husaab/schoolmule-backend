const { suggestForFamilies, suggestForCustomers, suggestFamilyForStudent } = require('../../../../services/finance/suggestions');

const families = [
  { family_id: 'fa', name: 'Rania Saleh', contacts: [{ email: 'rania.saleh@example.com', name: 'Rania Saleh' }], students: [{ name: 'Omar Saleh' }, { name: 'Dana Saleh' }] },
  { family_id: 'fb', name: 'Maha Younes', contacts: [{ email: 'maha.younes@example.com', name: 'Maha Younes' }], students: [{ name: 'Sara Younes' }] },
  { family_id: 'fc', name: 'Karim Haddad', contacts: [{ email: null, name: 'Karim Haddad' }], students: [{ name: 'Lina Haddad' }] },
];
const customers = [
  { qbo_id: '670', display_name: 'Rania Saleh', emails: ['Rania.Saleh@example.com'], is_sub_customer: false, active: true },
  { qbo_id: '169', display_name: 'M. Younes', emails: [], is_sub_customer: false, active: true },
  { qbo_id: '24', display_name: 'Sara Younes', emails: ['maha.younes@example.com'], is_sub_customer: true, active: true },
  { qbo_id: '999', display_name: 'Unknown Donor', emails: ['donor@example.com'], is_sub_customer: false, active: true },
  { qbo_id: '27', display_name: 'Haddad Karim', emails: [], is_sub_customer: false, active: false },
];

describe('suggestForFamilies', () => {
  it('ranks an email match first, then a name match, then a student-name match', () => {
    const out = suggestForFamilies(families, customers);
    const fa = out.find((f) => f.familyId === 'fa');
    expect(fa.candidates[0]).toMatchObject({ qboId: '670', reason: 'email' });
    const fb = out.find((f) => f.familyId === 'fb');
    // The child-named sub-customer carries the mother's email → email beats the fuzzy name match.
    expect(fb.candidates.map((c) => [c.qboId, c.reason])).toEqual([['24', 'email'], ['169', 'name']]);
    const fc = out.find((f) => f.familyId === 'fc');
    expect(fc.candidates[0]).toMatchObject({ qboId: '27', reason: 'name', active: false });
  });

  it('never suggests a customer that is already linked to another family', () => {
    const out = suggestForFamilies(families, customers, { linkedCustomerIds: new Set(['670']) });
    expect(out.find((f) => f.familyId === 'fa').candidates.map((c) => c.qboId)).not.toContain('670');
  });

  it('caps candidates at five and scores email highest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ qbo_id: String(100 + i), display_name: 'Rania Saleh', emails: [], active: true }));
    const out = suggestForFamilies([families[0]], [...many, customers[0]]);
    const cands = out[0].candidates;
    expect(cands).toHaveLength(5);
    expect(cands[0].qboId).toBe('670');
    expect(cands[0].score).toBeGreaterThan(cands[1].score);
  });
});

describe('suggestForCustomers', () => {
  it('finds families for an unlinked customer by email, then name, then a child name', () => {
    const out = suggestForCustomers(customers.filter((c) => c.qbo_id !== '999'), families);
    expect(out.find((c) => c.qboId === '670').candidates[0]).toMatchObject({ familyId: 'fa', reason: 'email' });
    expect(out.find((c) => c.qboId === '24').candidates[0]).toMatchObject({ familyId: 'fb', reason: 'email' });
    expect(out.find((c) => c.qboId === '27').candidates[0]).toMatchObject({ familyId: 'fc', reason: 'name' });
  });

  it('matches a child-named customer to the family that holds that student', () => {
    const out = suggestForCustomers([{ qbo_id: '24', display_name: 'Sara Younes', emails: [], active: true }], families);
    expect(out[0].candidates[0]).toMatchObject({ familyId: 'fb', reason: 'student' });
  });
});

describe('suggestFamilyForStudent', () => {
  it('suggests the family whose contact email matches a parent email on the student record', () => {
    const s = { student_id: 's9', name: 'Zayn Saleh', mother_email: 'RANIA.SALEH@example.com', father_email: null };
    expect(suggestFamilyForStudent(s, families)).toMatchObject({ familyId: 'fa' });
    expect(suggestFamilyForStudent({ ...s, mother_email: 'nobody@example.com' }, families)).toBeNull();
  });
});
