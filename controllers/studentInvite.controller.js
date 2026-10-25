/*
  controllers/studentInvite.controller.js
  The public side of a student invitation (/student-invite#<secret>), before
  anyone is signed in:

    POST /api/auth/student-invite         { token }  who the invite is for
    POST /api/auth/student-invite/accept  { token, password } | { token, googleCode }

  Accepting never creates a student, a login or a link: the invite already
  names the login and the student row the admin chose. It only sets the
  login's credential (a password, or the student's own Google account), ends
  the invite and every reset link, stamps the activation, tells the guardians
  once, and signs the student in through the same gate as every sign-in.
  Neither route reads Authorization, so nothing about the caller's session
  changes what they see.
*/

const bcrypt = require('bcrypt');
const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/studentInvite.queries');
const userQueries = require('../queries/user.queries');
const adminUserQueries = require('../queries/adminUser.queries');
const googleSignInService = require('../services/google/googleSignIn');
const { getSchoolName } = require('../utils/schoolUtils');
const {
  hashInviteSecret, parseInviteToken, publicInviteState, recordActivation, passwordProblem, acceptGoogleChecks,
  notifyGuardiansOnce,
} = require('../services/classroom/studentInvites');
const { openSession, unusablePasswordHash } = require('./auth.controller');

const { GoogleSignInError } = googleSignInService;

const NOT_FOUND = { status: 404, code: 'INVITE_NOT_FOUND', message: "This link doesn't work. Check you opened the whole link from your email." };
const DEAD = {
  expired: { code: 'INVITE_EXPIRED', message: 'This invite has expired. Ask your teacher or the school office to send a new one.' },
  used: { code: 'INVITE_USED', message: 'This invite was already used. Sign in instead.' },
  replaced: { code: 'INVITE_REPLACED', message: 'This link was replaced by a newer one. Check your email for the latest invite.' },
  cancelled: { code: 'INVITE_CANCELLED', message: 'This invite was cancelled. Ask your school office if you need a new one.' },
};
const dead = (state) => ({ status: 410, ...DEAD[state], data: { state } });

/** The invite a body's token names, or null. */
async function findInvite(token, client = db) {
  const secret = parseInviteToken(token);
  if (!secret) return null;
  const { rows } = await client.query(q.selectInviteByHash, [hashInviteSecret(secret)]);
  return rows[0] || null;
}

/**
 * The invite's state for the student: a live invite also has to still point
 * at a usable login of its school, linked to the invited row, at the address
 * it was sent to (an address change or relink makes it cancelled).
 */
function stateOf(inv) {
  const state = publicInviteState(inv);
  if (state !== 'valid') return state;
  const usable = inv.user_id && inv.user_role === 'STUDENT' && inv.user_school === inv.school && !inv.is_archived
    && inv.linked && String(inv.user_email || '').toLowerCase() === inv.email;
  return usable ? 'valid' : 'cancelled';
}

const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const lastWords = (name) => String(name || '').trim().split(/\s+/).slice(1).join(' ');
const lastInitial = (name) => {
  const words = String(name || '').trim().split(/\s+/);
  return words.length > 1 ? words[words.length - 1].charAt(0).toUpperCase() : '';
};

// POST /api/auth/student-invite  { token }
const inspectInvite = async (req) => {
  const inv = await findInvite(req.body?.token);
  if (!inv) return { ...NOT_FOUND };
  return {
    status: 200,
    message: 'Invite found',
    data: {
      state: stateOf(inv),
      school: { code: inv.school, name: inv.school_name || getSchoolName(inv.school) },
      // The full last name too, for the page's password check (the email already greets the student by full name).
      student: {
        firstName: firstWord(inv.student_name),
        lastName: lastWords(inv.student_name),
        lastInitial: lastInitial(inv.student_name),
        grade: inv.grade,
      },
      email: inv.email,
      methods: { google: true, password: inv.student_sign_in !== 'google_only' },
      expiresAt: new Date(inv.expires_at).toISOString(),
    },
  };
};

// POST /api/auth/student-invite/accept  { token, password } | { token, googleCode }
const acceptInvite = async (req) => {
  const { token, password, googleCode } = req.body ?? {};
  const usingGoogle = typeof googleCode === 'string' && googleCode.length > 0;
  if (!usingGoogle && typeof password !== 'string') {
    return { status: 400, code: 'PASSWORD_REQUIRED', message: 'Choose a password, or continue with Google.' };
  }

  try {
    const found = await findInvite(token);
    if (!found) return { ...NOT_FOUND };
    if (stateOf(found) !== 'valid') return dead(stateOf(found));
    if (!usingGoogle && found.student_sign_in === 'google_only') {
      return { status: 403, code: 'PASSWORD_SIGN_IN_OFF', message: 'Your school uses Google to sign in. Tap Continue with Google.' };
    }

    // Everything that needs no lock first: Google's answer, the password rules, the hash.
    let google = null;
    let credential;
    if (usingGoogle) {
      google = await googleSignInService.verifySignInCode(googleCode, googleSignInService.nativeFieldsOf(req.body));
      const verdict = acceptGoogleChecks(google, { email: found.user_email }, found.student_email_domains);
      if (verdict) return verdict;
      const { rows: taken } = await db.query(q.selectOtherGoogleUser, [google.sub, found.user_id]);
      if (taken.length > 0) {
        return { status: 409, code: 'GOOGLE_IN_USE', message: 'This Google account is already linked to another SchoolMule account.' };
      }
      credential = await unusablePasswordHash();
    } else {
      const problem = passwordProblem(password, {
        email: found.user_email,
        firstName: found.first_name,
        lastName: found.last_name,
        schoolName: found.school_name || '',
      });
      if (problem) return { status: 400, code: 'PASSWORD_WEAK', message: problem };
      credential = await bcrypt.hash(password, 10);
    }

    const via = usingGoogle ? 'google' : 'password';
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Re-read under the row lock: a second accept of the same link waits here.
      const { rows: [inv] } = await client.query(q.selectInviteForUpdate, [found.invite_id]);
      const state = inv ? stateOf(inv) : 'cancelled';
      if (state !== 'valid') {
        await client.query('ROLLBACK');
        return dead(state);
      }
      if (usingGoogle) {
        await client.query(userQueries.linkGoogleAccount, [inv.user_id, google.sub, credential]);
      } else {
        await client.query(userQueries.updatePassword, [credential, inv.user_id]);
      }
      await client.query(q.markAccepted, [inv.invite_id, via]);
      await client.query(adminUserQueries.deleteTokensForUser, [inv.user_id]);
      await recordActivation(client, { userId: inv.user_id, via });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return { status: 409, code: 'GOOGLE_IN_USE', message: 'This Google account is already linked to another SchoolMule account.' };
      }
      throw err;
    } finally {
      client.release();
    }

    await notifyGuardiansOnce({ userId: found.user_id, via });

    // Sign the student straight in, through the same gate as every sign-in.
    const { rows: [user] } = await db.query(userQueries.selectById, [found.user_id]);
    try {
      return await openSession(req, user, { email: user.email, message: 'Account set up' });
    } catch (verdict) {
      if (!verdict || !verdict.code) throw verdict;
      // Set up, but the school hasn't opened sign-in for this student yet.
      return { status: 200, message: verdict.message, data: { activated: true, signedIn: false, code: verdict.code, message: verdict.message } };
    }
  } catch (error) {
    if (error instanceof GoogleSignInError) return { status: 400, code: 'GOOGLE_FAILED', message: error.message };
    logger.error({ err: error }, 'Accepting a student invite failed');
    return { status: 500, message: 'Something went wrong. Please try again.' };
  }
};

module.exports = { inspectInvite, acceptInvite };
