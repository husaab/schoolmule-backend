const { recipientEmails, SQL } = require('../../../../services/access/recipients');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const db = require('../../../__mocks__/config/database');

describe('recipientEmails (RBAC D12)', () => {
  it("asks for the key's holders and returns their addresses", async () => {
    mockQueryResponse([{ email: 'office@test.com' }, { email: 'principal@test.com' }]);
    expect(await recipientEmails('ALHAADIACADEMY', 'users')).toEqual(['office@test.com', 'principal@test.com']);
    expect(db.query).toHaveBeenCalledWith(SQL, ['ALHAADIACADEMY', 'users', false]);
  });

  it('includes built-in teachers only for keys in the teacher default', async () => {
    mockQueryResponse([]);
    await recipientEmails('ALHAADIACADEMY', 'report_cards');
    expect(db.query.mock.calls[0][1]).toEqual(['ALHAADIACADEMY', 'report_cards', true]);
  });

  it('filters out archived, unverified and address-less accounts in SQL', () => {
    expect(SQL).toMatch(/is_archived IS NOT TRUE/);
    expect(SQL).toMatch(/is_verified IS TRUE/);
    expect(SQL).toMatch(/is_verified_school IS TRUE/);
    expect(SQL).toMatch(/TRIM\(COALESCE\(u\.email, ''\)\) <> ''/);
  });

  it('refuses a mistyped key', async () => {
    await expect(recipientEmails('ALHAADIACADEMY', 'user')).rejects.toThrow('Unknown permission key');
  });
});
