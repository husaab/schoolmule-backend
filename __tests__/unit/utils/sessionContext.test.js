const db = require('../../__mocks__/config/database');
const { getRolesForUser } = require('../../../utils/sessionContext');

describe('getRolesForUser', () => {
  it('a STUDENT holds only the STUDENT view and no lookup is made', async () => {
    await expect(getRolesForUser({ user_id: 'u-student', role: 'STUDENT' })).resolves.toEqual(['STUDENT']);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a PARENT holds only the PARENT view and no lookup is made', async () => {
    await expect(getRolesForUser({ user_id: 'u-parent', role: 'PARENT' })).resolves.toEqual(['PARENT']);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a TEACHER linked to a current student also holds PARENT', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    await expect(getRolesForUser({ user_id: 'u-teacher', role: 'TEACHER' })).resolves.toEqual(['TEACHER', 'PARENT']);
  });

  it('a TEACHER with no student links holds only TEACHER', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(getRolesForUser({ user_id: 'u-teacher', role: 'TEACHER' })).resolves.toEqual(['TEACHER']);
  });
});
