// RBAC fixtures for unit tests. unitSetup.js stands in for the access store
// and derives each account from its token; these override one account.
const store = require('../../services/access/accessStore');

const ROLE_ID = '77777777-7777-4777-8777-777777777777';

module.exports = {
  ROLE_ID,
  /** This account holds a custom staff role with exactly `permissions`. */
  giveRole: (userId, permissions, name = 'Test Role', id = ROLE_ID) =>
    store.__rows.set(userId, { staff_role_id: id, role_found: true, role_name: name, permissions }),
  /** The account points at a role that no longer exists: must grant nothing. */
  giveDanglingRole: (userId) => store.__rows.set(userId, { staff_role_id: ROLE_ID, role_found: false }),
  archive: (userId) => store.__rows.set(userId, { is_archived: true }),
  /** Any other row fields (base_role, is_verified_school, school). */
  setRow: (userId, fields) => store.__rows.set(userId, fields),
};
