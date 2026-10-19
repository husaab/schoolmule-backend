// services/classroom/studentLogin.js
//
// Who may sign in as a student right now, and the QR card secret.
//
// A QR card's token is `${userId}.${secret}`: the secret is 32 random bytes
// (base64url, 43 characters) and only its SHA-256 is stored on
// student_accounts, so a lost card is voided by issuing a new secret and a
// database leak never yields a working card. The printed QR holds the plain
// text `SCHOOLMULE-QR:<token>`, never a URL (final ruling): a phone camera
// can't turn it into a sign-in link left in a shared device's history; the
// app's own "Scan my card" reads it and posts it to /api/auth/student-qr,
// which takes the token with or without the prefix.
//
// A session opened with a card carries `qrCard` (the first 16 hex of the
// card's hash) and ends once that card is voided or replaced by a reprint
// (qrCardLive, checked by requireStudent and /api/auth/me).

const crypto = require('crypto');
const db = require('../../config/database');
const { gradeRank } = require('../../utils/gradeRank');

const hashQrSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const issueQrSecret = () => {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: hashQrSecret(secret) };
};
const QR_PAYLOAD_PREFIX = 'SCHOOLMULE-QR:';
const qrToken = (userId, secret) => `${userId}.${secret}`;
/** What the printed QR code holds: plain text, no URL. */
const qrPayload = (userId, secret) => `${QR_PAYLOAD_PREFIX}${qrToken(userId, secret)}`;
/** A card token, bare or as the scanned payload (prefix in any case), or null. */
const parseQrToken = (token) => {
  const m = /^(?:SCHOOLMULE-QR:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(String(token || '').trim());
  return m ? { userId: m[1].toLowerCase(), secret: m[2] } : null;
};
/** The card a QR session came from, as its token claim. */
const qrCardFingerprint = (hash) => (typeof hash === 'string' && hash.length >= 16 ? hash.slice(0, 16) : null);
/** Is the card a session came from still the live one? A session not from a card always is. */
const qrCardLive = (qrCard, { qrSecretHash, qrVoidedAt } = {}) => {
  if (!qrCard) return true;
  return !qrVoidedAt && typeof qrSecretHash === 'string' && qrSecretHash.startsWith(String(qrCard));
};
const secretMatches = (secret, hash) => {
  if (!hash) return false;
  const a = Buffer.from(hashQrSecret(secret), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// $1 user_id, $2 school. The link is to the ACTIVE year's student row.
const SIGN_IN_CONTEXT = `
  SELECT scs.enabled, scs.login_from_grade, scs.qr_until_grade,
         sa.consent_at, sa.qr_secret_hash, sa.qr_voided_at, st.student_id, st.grade
  FROM users u
  LEFT JOIN school_classroom_settings scs ON scs.school = u.school
  LEFT JOIN student_accounts sa ON sa.user_id = u.user_id
  LEFT JOIN LATERAL (
    SELECT s.student_id, s.grade::text AS grade FROM student_account_links sal
    JOIN school_years sy ON sy.school_year_id = sal.school_year_id AND sy.is_active
    JOIN students s ON s.student_id = sal.student_id AND s.is_archived IS NOT TRUE
    WHERE sal.user_id = u.user_id LIMIT 1) st ON TRUE
  WHERE u.user_id = $1 AND u.school = $2`;

const verdict = (code, message) => ({ status: 403, code, message });

const MESSAGES = Object.freeze({
  CLASSROOM_DISABLED: "Student sign-in isn't turned on at your school yet.",
  NO_STUDENT_LINK: "Your account isn't set up for this school year yet. Ask your teacher.",
  CONSENT_REQUIRED: 'Your school needs a parent or guardian to agree before you can sign in.',
  GRADE_NOT_ENABLED: "Your grade doesn't use student sign-in yet.",
  QR_NOT_ENABLED: 'Sign in with your email and password.',
  QR_INVALID: "This card doesn't work any more. Ask your teacher for a new one.",
});

/** Throws a { status, code, message } verdict when this student may not sign in now. */
async function assertStudentCanSignIn(user, { via = 'password' } = {}) {
  const { rows } = await db.query(SIGN_IN_CONTEXT, [user.user_id, user.school]);
  const c = rows[0] || {};
  if (!c.enabled) throw verdict('CLASSROOM_DISABLED', MESSAGES.CLASSROOM_DISABLED);
  if (!c.student_id) throw verdict('NO_STUDENT_LINK', MESSAGES.NO_STUDENT_LINK);
  if (!c.consent_at) throw verdict('CONSENT_REQUIRED', MESSAGES.CONSENT_REQUIRED);
  // An unknown grade never gets a login (same rule as the invite).
  const rank = gradeRank(c.grade);
  if (rank === null || rank < gradeRank(c.login_from_grade)) throw verdict('GRADE_NOT_ENABLED', MESSAGES.GRADE_NOT_ENABLED);
  if (via === 'qr' && rank > gradeRank(c.qr_until_grade)) throw verdict('QR_NOT_ENABLED', MESSAGES.QR_NOT_ENABLED);
  return { studentId: c.student_id, grade: c.grade, qrSecretHash: c.qr_secret_hash, qrVoidedAt: c.qr_voided_at };
}

module.exports = {
  QR_PAYLOAD_PREFIX, hashQrSecret, issueQrSecret, qrToken, qrPayload, parseQrToken, qrCardFingerprint, qrCardLive,
  secretMatches, assertStudentCanSignIn, MESSAGES,
};
