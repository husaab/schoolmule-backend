// utils/emailLoginLink.js
//
// One-tap sign-in from a parent email. A button in the grades email opens
// /email-login?next=<path>#<token>; the page posts the token to
// POST /api/auth/email-link, which opens a normal parent session and sends
// the parent on to `next`. The token is in the fragment, so it never reaches
// a server log.
//
// The token is a JWT signed with a key of its own, derived from JWT_SECRET:
// a session token can never pass as an email link, nor the reverse. It names
// the parent account, the child the email was about and the address it was
// sent to; the endpoint re-checks all three, so a link dies when the parent
// is unlinked from the child, archived, or changes their email. Parent
// accounts only: a staff account never gets one.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PURPOSE = 'email-login';
const TTL = '30d';

const key = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update(PURPOSE).digest('base64url');

/** A token for `userId`, about `studentId`, sent to `email`. */
const signEmailLoginToken = ({ userId, studentId, email }) =>
  jwt.sign({ typ: PURPOSE, sid: studentId, em: String(email).trim().toLowerCase() }, key(), { subject: userId, expiresIn: TTL });

/** { userId, studentId, email } from a token; throws when it is forged, expired or not an email link. */
const verifyEmailLoginToken = (token) => {
  if (typeof token !== 'string' || !token) throw new Error('No token');
  const claims = jwt.verify(token, key());
  if (claims.typ !== PURPOSE || !claims.sub || !claims.sid || !claims.em) throw new Error('Not an email sign-in token');
  return { userId: claims.sub, studentId: claims.sid, email: claims.em };
};

/** The link a button carries: sign in with `token`, then open `next` (a path in the app). */
const emailLoginUrl = ({ token, next }) =>
  `${process.env.FRONTEND_URL || ''}/email-login?next=${encodeURIComponent(next)}#${token}`;

module.exports = { signEmailLoginToken, verifyEmailLoginToken, emailLoginUrl };
