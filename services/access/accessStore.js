// services/access/accessStore.js
//
// The only part of RBAC that reads the database: one indexed lookup of the
// account and its staff role, cached in-process for a few seconds. Role and
// user edits call invalidateAll / invalidateUser, so a change applies on this
// instance at once; another instance catches up within TTL_MS.

const db = require('../../config/database');

const TTL_MS = 10_000;
const cache = new Map(); // userId -> { row, at }

// Tagged so the query is easy to find in the logs. role is an enum in prod and
// TEXT in the test seed, hence the casts.
const SQL = `/* access:resolve */
  SELECT u.user_id, u.school::text AS school, u.role::text AS base_role,
         u.is_archived, u.is_verified_school, u.staff_role_id,
         (r.role_id IS NOT NULL) AS role_found,
         r.name AS role_name, r.permissions
    FROM users u
    LEFT JOIN staff_roles r ON r.role_id = u.staff_role_id AND r.school = u.school
   WHERE u.user_id = $1`;

/**
 * who = { userId } (the JWT payload or a session's user; only userId is read
 * here, the unit-test stand-in uses the rest). fresh=true skips the cache and
 * refills it. Null when the account is gone.
 */
async function fetchAccessRow(who, { fresh = false } = {}) {
  const { userId } = who;
  const hit = cache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const { rows } = await db.query(SQL, [userId]);
  const row = rows[0] || null;
  if (row) cache.set(userId, { row, at: Date.now() });
  else cache.delete(userId);
  return row;
}

// For the session payload only (not cached): does this account lead or
// co-teach a class of the school's active year? The UI uses it to show
// Classes and Class Attendance to someone without classes.all.
const TEACHES_SQL = `/* access:teaches */
  SELECT EXISTS (
    SELECT 1
      FROM classes c
      JOIN school_years sy ON sy.school_year_id = c.school_year_id AND sy.is_active = TRUE
     WHERE c.school = $2
       AND (c.teacher_id = $1
            OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
  ) AS teaches`;

/** who = { userId, school } */
async function teachesAnyClass(who) {
  const { rows } = await db.query(TEACHES_SQL, [who.userId, who.school]);
  return Boolean(rows[0] && rows[0].teaches);
}

const invalidateUser = (userId) => { cache.delete(userId); };
const invalidateAll = () => { cache.clear(); };

module.exports = { fetchAccessRow, teachesAnyClass, invalidateUser, invalidateAll, SQL, TEACHES_SQL, TTL_MS };
