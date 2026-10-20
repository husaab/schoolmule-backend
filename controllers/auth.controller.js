const crypto = require("crypto");
const db = require("../config/database");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userQueries = require("../queries/user.queries");
const passwordQueries = require('../queries/password.queries');
const logger = require("../logger");
const { sessionAccess } = require('../services/access/access');
const { recipientEmails } = require('../services/access/recipients');
const { getVerificationEmailHTML, getConfirmedEmailHTML, getApprovalEmailHTML, getAdminNotifyEmailHTML,
  getResetEmailHTML } = require('../templates/emailTemplate');
const approvalActions = require('../services/approvalActions');
const { SIGNUP_ROLES } = approvalActions;

const { getActiveTermForSchool, getSchoolYearContext, getRolesForUser } = require('../utils/sessionContext');
const { getResend, sendOrThrow, sendSafely } = require('../utils/emailUtils');
const { platformSender } = require('../services/email/senderIdentity');
const observeBuffer = require('../services/observe/eventBuffer');
const { isPlatformOwner } = require('../middleware/requirePlatformOwner');
const googleSignInService = require('../services/google/googleSignIn');
const { GoogleSignInError } = googleSignInService;
const {
  assertStudentCanSignIn, parseQrToken, secretMatches, qrCardFingerprint, qrCardLive, sessionRevoked, MESSAGES: STUDENT_MESSAGES,
} = require('../services/classroom/studentLogin');
const { photoUrlFor } = require('../services/profile/photos');
const studentAccountQueries = require('../queries/studentAccount.queries');
const { getSettings: getClassroomSettings } = require('../services/classroom/classroomSettings');
const {
  recordActivation, acceptGoogleChecks, recordGoogleAcceptance, passwordProblem,
} = require('../services/classroom/studentInvites');

const SESSION_TTL = '7d';
// Students often share school computers (spec §6): their sessions are short.
const STUDENT_SESSION_TTL = '12h';

// The session JWT. `role` is the view the user is acting in and is what every
// guard reads; `baseRole` is the database role and `roles` every view the
// user may switch to (utils/sessionContext.getRolesForUser). For most users
// all three say the same thing. A staff member who is also a parent carries
// roles [TEACHER, PARENT] and flips `role` through POST /auth/view.
// `qrCard`: a session opened with a QR card names the card (its hash's
// first 16 hex), so it ends once that card is voided or reprinted.
const signSessionToken = ({ user, role, roles, activeTerm, qrCard = null }) =>
  jwt.sign(
    {
      ...(qrCard && { qrCard }),
      userId: user.user_id,
      username: user.username,
      email: user.email,
      school: user.school,
      role,
      baseRole: user.role,
      roles,
      isVerified: user.is_verified,
      isVerifiedSchool: user.is_verified_school,
      activeTerm: activeTerm ? activeTerm.name : false,
    },
    process.env.JWT_SECRET,
    { expiresIn: user.role === 'STUDENT' ? STUDENT_SESSION_TTL : SESSION_TTL }
  );

// RBAC: what the active view may do (permissions, isFullAdmin, accessRole,
// teachesClasses). UI hints for the frontend; every API checks for itself.
const sessionAccessFor = (user, view) =>
  sessionAccess({ userId: user.user_id, school: user.school, baseRole: user.role }, view);

// The identity half of a session response, shared by login, /me and /view so
// the client hydrates its stores the same way whichever one it called.
const sessionIdentity = (user, role, roles, photoUrl = null) => ({
  userId: user.user_id,
  username: user.username,
  fullName: `${user.first_name} ${user.last_name}`,
  email: user.email,
  school: user.school,
  role,
  baseRole: user.role,
  roles,
  isVerified: user.is_verified,
  isVerifiedSchool: user.is_verified_school,
  isPlatformOwner: isPlatformOwner(user.email),
  // The picked avatar ({style, skin, bg}, null = neutral) and a signed URL for
  // the optional photo (null without one, or for a student while photos are off).
  avatar: user.avatar ?? null,
  photoUrl,
  createdAt: user.created_at,
  lastModifiedAt: user.last_modified_at,
});

// Sign-in addresses match ignoring case, so "Amal.Haddad@Example.com" opens
// amal.haddad@example.com. users.email is unique only as typed, so two old
// accounts can differ by case alone: the exact spelling wins, and with no
// exact match among several candidates no account is picked.
const typedEmail = (raw) => (typeof raw === 'string' ? raw.trim() : '');
const AMBIGUOUS_EMAIL = Object.freeze({
  status: 409,
  code: 'EMAIL_AMBIGUOUS',
  message: "More than one account uses this email address with different capital letters. Type it exactly as it was set up, or ask your school to fix the account.",
});
// Signup refuses an address that already has an account, in any spelling:
// a second spelling would be one more pair the rule above can't tell apart.
// The refusal names the way in that works for that account.
const ARCHIVED_MESSAGE = 'This account has been archived. Contact your school admin.';
const EMAIL_TAKEN = Object.freeze({
  status: 400,
  code: 'EMAIL_TAKEN',
  message: 'An account with this email already exists. Sign in instead, or reset your password if you forgot it.',
});
const SIGNUP_INVITED = Object.freeze({
  status: 400,
  code: 'ACCOUNT_INVITED',
  message: "You've already been invited with this email. Use the link in your invite email to set your password, or reset your password to get a new link.",
});
const SIGNUP_ARCHIVED = Object.freeze({ status: 400, code: 'ACCOUNT_ARCHIVED', message: ARCHIVED_MESSAGE });
/** selectByEmailIgnoringCase rows (at least one) → the signup refusal for them. */
const signupRefusalFor = (rows, typed) => {
  const { user } = matchAccountByEmail(rows, typed);
  if (user?.is_archived) return SIGNUP_ARCHIVED;
  // A student's invite is accepted on /student-invite, never by a reset.
  if (user?.invite_pending && user.role !== 'STUDENT') return SIGNUP_INVITED;
  return EMAIL_TAKEN;
};
// Same minimum as the signup form and Forgot password.
const SIGNUP_PASSWORD_MIN = 6;
/** loginUser-style rows → { user } (null when none) or { ambiguous: true }. */
const matchAccountByEmail = (rows, typed) => {
  if (rows.length <= 1) return { user: rows[0] || null };
  const exact = rows.find((r) => r.email === typed);
  return exact ? { user: exact } : { user: null, ambiguous: true };
};

// Every sign-in attempt, however it ends, becomes a login_events row.
const recordLogin = (req, { email, user, outcome }) => {
  observeBuffer.push('login_events', {
    email: String(email || '').trim().toLowerCase(),
    user_id: user ? user.user_id : null,
    school: user ? user.school : null,
    outcome,
    ip: req.ip || null,
    user_agent: req.headers['user-agent'] || null,
  });
};

// Everything after "this person proved who they are", shared by the password,
// Google and QR-card sign-ins so all apply the same rules: the archive gate,
// the student gate, the admin flag repair, the login_events row and the
// session payload. Throws a { status, message, code? } verdict for an
// archived account or a student who may not sign in now. `via` is 'qr' for a
// QR card (only the youngest grades may use one).
const openSession = async (req, user, { email, message, via = 'password', qrCard = null }) => {
  // Archived accounts keep their history but can't sign in.
  if (user.is_archived) {
    recordLogin(req, { email, user, outcome: 'archived' });
    throw { status: 403, message: ARCHIVED_MESSAGE };
  }

  // Students also need classrooms on, a link to this year's row, consent and
  // an enabled grade (services/classroom/studentLogin.js).
  if (user.role === 'STUDENT') {
    try {
      await assertStudentCanSignIn(user, { via });
    } catch (v) {
      recordLogin(req, { email, user, outcome: 'student_blocked' });
      throw v;
    }
  }

  // Admins skip both checks. Persist it, not just the token: otherwise
  // /me reads false from the database, sees drift and reissues a token
  // that every route then rejects as ACCOUNT_NOT_VERIFIED.
  if (user.role === 'ADMIN' && (!user.is_verified || !user.is_verified_school)) {
    await db.query(userQueries.markAdminVerified, [user.user_id]);
    logger.info({ userId: user.user_id, school: user.school }, "Admin account marked verified at login");
    user.is_verified = true;
    user.is_verified_school = true;
  }

  recordLogin(req, { email, user, outcome: user.is_verified && user.is_verified_school ? 'success' : 'not_verified' });
  db.query(userQueries.touchLastLogin, [user.user_id]).catch((err) => {
    logger.warn({ observe: true, err }, 'last_login_at update failed');
  });

  const activeTerm = await getActiveTermForSchool(user.school);
  const yearContext = await getSchoolYearContext(user.school);
  // Sign-in always starts in the database role; the parent view is a switch away.
  const roles = await getRolesForUser(user);

  const token = signSessionToken({ user, role: user.role, roles, activeTerm, qrCard });
  const photoUrl = await photoUrlFor(user);

  return {
    status: 200,
    message,
    data: {
      ...sessionIdentity(user, user.role, roles, photoUrl),
      ...(await sessionAccessFor(user, user.role)),
      activeTerm: activeTerm ? activeTerm.name : false,
      activeSchoolYear: yearContext.activeSchoolYear,
      schoolYears: yearContext.schoolYears,
      token: token
    }
  };
};

// The two emails that follow an address being confirmed, by the link in the
// verification email or by Google: a note to the person, and the "awaiting
// approval" heads-up to their school's admins. Courtesy emails only: neither
// may fail the request that triggered them, so this never throws.
const notifyAccountVerified = async (user) => {
  await sendSafely(getResend(), {
    ...platformSender('verify'),
    to: user.email,
    subject: 'Your Email Has Been Verified at School Mule',
    html: getConfirmedEmailHTML({ name: user.username }),
  }, "Email-verified confirmation failed to send", { userId: user.user_id });

  // Everyone who approves sign-ups (RBAC `users`, D12), never archived or
  // unapproved accounts.
  let recipients;
  try {
    recipients = await recipientEmails(user.school, 'users');
  } catch (err) {
    logger.error({ err, school: user.school, userId: user.user_id }, "Admin lookup for approval notification failed");
    return;
  }

  logger.info({ school: user.school, recipientCount: recipients.length }, "Notifying the school's approvers");
  if (recipients.length === 0) return;
  await sendSafely(getResend(), {
    ...platformSender('notification'),
    to: recipients,
    subject: 'New User Awaiting School Approval',
    html: getAdminNotifyEmailHTML({ new_user: user.username, school: user.school }),
  }, "Admin approval notification failed to send", { school: user.school, userId: user.user_id });
};

// A password nobody knows. Google-only accounts still need a bcrypt hash in
// the NOT NULL column, and '!' is taken: it means "invite not yet accepted".
// "Forgot password" still lets them set a real one later.
const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

  const registerUser = async (req, res) => {
    const saltRounds = 10;
    const { username, email, password, school, role } = req.body ?? {};

    // A bad request is answered before a connection is taken.
    if ([username, email, password, school, role].some((v) => typeof v !== 'string' || v.trim() === '')) {
      return { status: 400, message: "Missing required fields" };
    }
    // The form checks this too; the API must not take a shorter one.
    if (password.length < SIGNUP_PASSWORD_MIN) {
      return { status: 400, code: 'PASSWORD_TOO_SHORT', message: `Password must be at least ${SIGNUP_PASSWORD_MIN} characters.` };
    }
    // Public signup can only ask for a teacher or parent account. Admins
    // skip the approval queue at login, so letting a request pick ADMIN
    // would hand out full access to anyone who finds this endpoint.
    if (!SIGNUP_ROLES.includes(role)) {
      return { status: 400, message: "Please sign up as a teacher or a parent." };
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // users.email is unique only as typed, so look for every spelling.
      const typed = typedEmail(email);
      const existing = await client.query(userQueries.selectByEmailIgnoringCase, [typed]);
      if (existing.rowCount > 0) {
        await client.query('ROLLBACK');
        return { ...signupRefusalFor(existing.rows, typed) };
      }

      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const [firstName = '', lastName = ''] = username.split(" ");

      const userId = uuidv4();
      const emailToken = uuidv4();
      const isVerified = false;
      const isVerifiedSchool = false;

      const values = [
        userId,
        email,
        username,
        hashedPassword,
        firstName,
        lastName,
        school,
        role,
        emailToken,
        isVerified,
        isVerifiedSchool
      ];

      const result = await client.query(userQueries.createUser, values);
      const user = result.rows[0];

      await client.query('COMMIT');

      const verificationUrl = `${process.env.FRONTEND_URL}/verify-email-token?token=${user.email_token}`;
      const html = getVerificationEmailHTML({
        name: user.first_name,
        url: verificationUrl
      });

      // The account is committed either way. A rejected email must not turn a
      // successful signup into a 500 (the next attempt would hit "email already
      // exists"); the verify-email page offers a resend.
      const emailSent = await sendSafely(getResend(), {
        ...platformSender('verify'),
        to: user.email,
        subject: 'Verify your email at School Mule',
        html
      }, "Signup verification email failed to send", { userId: user.user_id });

      // Get active term for the user's school
      const activeTerm = await getActiveTermForSchool(user.school);
      const yearContext = await getSchoolYearContext(user.school);

      // Create JWT token with user data
      const tokenPayload = {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        activeTerm: activeTerm ? activeTerm.name : null
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
        expiresIn: '7d'
      });

      return {
        status: 200,
        message: emailSent
          ? "User registered successfully. A verification email has been sent."
          : "User registered, but the verification email could not be sent. Use \"Resend verification email\" to try again.",
        data: {
          emailSent,
          userId: user.user_id,
          username: user.username,
          fullName: `${user.first_name} ${user.last_name}`,
          email: user.email,
          school: user.school,
          role: user.role,
          isVerified: user.is_verified,
          isVerifiedSchool: user.is_verified_school,
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at,
          activeTerm: activeTerm ? activeTerm.name : null,
          activeSchoolYear: yearContext.activeSchoolYear,
          schoolYears: yearContext.schoolYears,
          token: token
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      // Two signups for one address racing past the check above. An answer,
      // not a failure: keep it out of the error log.
      if (error.code === '23505' && error.constraint === 'users_duplicate_email_key') {
        return { ...EMAIL_TAKEN };
      }
      logger.error({ err: error }, "User registration failed");

      return {
        status: 500,
        message: error.message || "Internal Server Error"
      };
    } finally {
      client.release();
    }
  };
  

// A student's password sign-in (and "Forgot password") is refused in two
// cases, each with the way in that works: a school that signs students in
// with Google only, and a student who hasn't set up their account yet (the
// invite placeholder; the invite or Google is how they start).
const PASSWORD_SIGN_IN_OFF = Object.freeze({
  status: 403, code: 'PASSWORD_SIGN_IN_OFF', message: 'Your school uses Google to sign in. Tap Continue with Google.',
});
const INVITE_PENDING = Object.freeze({
  status: 403, code: 'INVITE_PENDING',
  message: "You haven't set up your account yet. Use the invite in your email, or Continue with Google.",
});
async function studentPasswordVerdict(user) {
  const { studentSignIn } = await getClassroomSettings(user.school);
  if (studentSignIn === 'google_only') return PASSWORD_SIGN_IN_OFF;
  if (user.invite_pending ?? user.password === '!') return INVITE_PENDING;
  return null;
}
async function assertStudentPasswordAllowed(user) {
  const verdict = await studentPasswordVerdict(user);
  if (verdict) throw { ...verdict };
}

  const login = async (req, res) => {
    const { email, password } = req.body;
    let user = null;

    try {
      const typed = typedEmail(email);
      const result = await db.query(userQueries.loginUser, [typed]);
      const match = matchAccountByEmail(result.rows, typed);

      if (match.ambiguous) {
        recordLogin(req, { email, user: null, outcome: 'ambiguous_email' });
        throw { ...AMBIGUOUS_EMAIL };
      }
      if (!match.user) {
        recordLogin(req, { email, user: null, outcome: 'unknown_email' });
        throw { status: 404, message: "User not found" };
      }

      user = match.user;
      if (user.role === 'STUDENT') await assertStudentPasswordAllowed(user);
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        recordLogin(req, { email, user, outcome: 'bad_password' });
        throw { status: 401, message: "Invalid credentials" };
      }

      return await openSession(req, user, { email, message: "User login successful" });
    } catch (error) {
      // A thrown { status, message } is a verdict, not a failure: keep its
      // status so a wrong password is a 401 and never counts as a 500.
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) logger.error({ err: error }, "Login failed");
      return {
        status,
        // The verdict's machine-readable reason (e.g. CLASSROOM_DISABLED).
        ...(status < 500 && error.code && { code: error.code }),
        message: error.message || "Internal Server Error"
      };
    }
  };

const QR_INVALID = {
  status: 401,
  code: 'QR_INVALID',
  message: STUDENT_MESSAGES.QR_INVALID,
};

// POST /api/auth/student-qr { token }
//
// A student's printed QR card holds SCHOOLMULE-QR:<userId>.<secret> (plain
// text); the app's scanner posts it here (the bare token works as well). Only the SHA-256 of the card's secret is stored, and a
// reprint or a void replaces it, so an old card answers 401 QR_INVALID. A
// valid card then goes through the same openSession gate as a password,
// with the QR grade limit on top. Same response as /api/auth/login.
const studentQrLogin = async (req) => {
  const parsed = parseQrToken(req.body?.token);
  let user = null;

  try {
    if (parsed) {
      const { rows } = await db.query(studentAccountQueries.selectQrLoginUser, [parsed.userId]);
      user = rows[0] || null;
    }
    if (!user || String(user.role) !== 'STUDENT' || user.qr_voided_at || !secretMatches(parsed.secret, user.qr_secret_hash)) {
      recordLogin(req, { email: user ? user.email : '', user, outcome: 'qr_invalid' });
      return { ...QR_INVALID };
    }
    const session = await openSession(req, user, {
      email: user.email, message: 'Signed in', via: 'qr', qrCard: qrCardFingerprint(user.qr_secret_hash),
    });
    // A first scan counts as the student's activation (no guardian email: the card is used at school).
    await recordActivation(db, { userId: user.user_id, via: 'card' }).catch((err) => {
      logger.warn({ err, userId: user.user_id }, 'Recording a QR activation failed');
    });
    return session;
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) {
      logger.error({ err: error }, "QR sign-in failed");
      return { status, message: "Sign-in failed. Please try again." };
    }
    return { status, ...(error.code && { code: error.code }), message: error.message };
  }
};

const GOOGLE_INTENTS = ['login', 'signup'];

// The existing account a Google identity opens, or null when there is none.
// An account already linked to this Google account wins; otherwise the email
// decides. Throws a verdict when the email can't pick one account safely.
const matchGoogleAccount = (rows, google) => {
  const linked = rows.find((r) => r.google_sub === google.sub);
  if (linked) return linked;

  const byEmail = rows.filter((r) => r.email.toLowerCase() === google.email.toLowerCase());
  if (byEmail.length === 0) return null;

  const user = byEmail.length === 1 ? byEmail[0] : byEmail.find((r) => r.email === google.email);
  if (!user) {
    throw { status: 409, message: "More than one account uses this email. Sign in with your email and password instead." };
  }
  if (user.google_sub) {
    throw { status: 409, message: "This account is linked to a different Google account. Use that Google account, or sign in with your email and password." };
  }
  return user;
};

// First Google sign-in on an account: remember the Google account, count
// Google's check as email verification, and accept a pending invite.
//
// A password set before anyone proved they own the address can't be trusted
// once Google proves who does: anyone can sign up with someone else's email
// and wait for the owner to arrive through Google. So an unverified account's
// password is replaced along with the invite sentinel '!'. A verified
// account's password was set by the owner and keeps working.
const linkGoogleAccount = async (user, google) => {
  const replacePassword = !user.is_verified || user.password === '!';
  // Archived: openSession refuses it; leave the row as it is.
  if (user.is_archived || (user.google_sub === google.sub && !replacePassword)) return user;

  const { rows } = await db.query(userQueries.linkGoogleAccount, [
    user.user_id,
    google.sub,
    replacePassword ? await unusablePasswordHash() : null,
  ]);
  const linked = rows[0];

  // Google just did what the verification link would have done, so send what
  // the link would have sent.
  if (!user.is_verified && !linked.is_verified_school && linked.role !== 'ADMIN') {
    await notifyAccountVerified(linked);
  }
  return linked;
};

// Google gives names as parts; some accounts carry only `name`, and a few
// carry no name at all.
const namesFromGoogle = (google) => {
  if (google.givenName || google.familyName) return [google.givenName, google.familyName];
  const [first = '', ...rest] = google.name.trim().split(/\s+/);
  return [first || google.email.split('@')[0], rest.join(' ')];
};

const createGoogleAccount = async ({ google, school, role }) => {
  const [firstName, lastName] = namesFromGoogle(google);
  try {
    const { rows } = await db.query(userQueries.createGoogleUser, [
      uuidv4(),
      google.email,
      [firstName, lastName].filter(Boolean).join(' '),
      await unusablePasswordHash(),
      firstName,
      lastName,
      school,
      role,
      google.sub,
    ]);
    return rows[0];
  } catch (error) {
    // Lost a race with another signup for this address or Google account.
    if (error.code === '23505') {
      throw { status: 409, message: "An account with this email already exists. Try signing in instead." };
    }
    // Not a school label Postgres knows.
    if (error.code === '22P02') throw { status: 400, message: "We couldn't find that school." };
    throw error;
  }
};

// POST /api/auth/google { code, intent: 'login'|'signup', school?, role? }
//
// `code` comes from Google's sign-in popup. Signing in opens the account the
// Google identity matches; with no match, login answers 404 GOOGLE_NO_ACCOUNT
// and signup creates a pending account for `school` as `role`. A signup whose
// email already has an account simply signs in (`accountCreated: false`).
// Either way the response is the login payload, gated the same way: pending
// accounts get a session that only reaches the waiting page.
const googleSignIn = async (req) => {
  const { code, intent = 'login', school, role } = req.body ?? {};
  let email = null;

  try {
    if (typeof code !== 'string' || !code) throw { status: 400, message: "Missing Google sign-in code." };
    if (!GOOGLE_INTENTS.includes(intent)) throw { status: 400, message: "Unknown Google sign-in request." };
    // Same guard as /register: a public signup is only ever a teacher or a parent.
    if (intent === 'signup' && (!school || !SIGNUP_ROLES.includes(role))) {
      throw { status: 400, message: "Please sign up as a teacher or a parent." };
    }

    const google = await googleSignInService.verifySignInCode(code);
    email = google.email;

    // Matching accounts by email is only safe when Google vouches for it.
    if (!google.emailVerified) {
      recordLogin(req, { email, user: null, outcome: 'google_unverified_email' });
      throw { status: 403, message: "Google hasn't verified this account's email address, so it can't be used here. Sign in with your email and password instead." };
    }

    const { rows } = await db.query(userQueries.selectForGoogleSignIn, [google.sub, google.email]);
    let user = matchGoogleAccount(rows, google);
    let accountCreated = false;

    if (user) {
      // A student's first Google link: an address on the school's declared
      // student domain must come from that Google Workspace domain.
      const firstStudentLink = user.role === 'STUDENT' && !user.google_sub;
      if (firstStudentLink) {
        const { studentEmailDomains } = await getClassroomSettings(user.school);
        const verdict = acceptGoogleChecks(google, user, studentEmailDomains);
        if (verdict) throw verdict;
      }
      const wasPending = user.role === 'STUDENT' && user.password === '!';
      user = await linkGoogleAccount(user, google);
      // A pending student's first Google sign-in accepts the invite (R2).
      if (wasPending && !user.is_archived) await recordGoogleAcceptance(user.user_id);
    } else if (intent === 'signup') {
      user = await createGoogleAccount({ google, school, role });
      accountCreated = true;
      await notifyAccountVerified(user);
    } else {
      recordLogin(req, { email, user: null, outcome: 'unknown_email' });
      return {
        status: 404,
        code: 'GOOGLE_NO_ACCOUNT',
        message: "There's no SchoolMule account for this Google email.",
        data: { email: google.email },
      };
    }

    const session = await openSession(req, user, {
      email,
      message: accountCreated ? "Account created" : "User login successful",
    });
    session.data.accountCreated = accountCreated;
    return session;
  } catch (error) {
    if (error instanceof GoogleSignInError) return { status: 400, message: error.message };
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) {
      logger.error({ err: error }, "Google sign-in failed");
      return { status, message: "Google sign-in failed. Please try again." };
    }
    return { status, ...(error.code && { code: error.code }), message: error.message };
  }
};

  const sendVerificationEmail = async (req, res) => {
    const { email } = req.body;
  
    try {
      const sql = userQueries.selectByEmail;
      const result = await db.query(sql, [email]);
  
      if (result.rows.length === 0) {
        throw { status: 404, message: "User not found" };
      }
  
      const user = result.rows[0];
      // This route isn't wrapped in responseParser: answer through res, or
      // the request hangs.
      if (user.is_verified) {
        return res.status(200).json({
          success: true,
          message: "User already verified",
          data: { alreadyVerified: true }
        });
      }
  
      const verificationUrl = `${process.env.FRONTEND_URL}/verify-email-token?token=${user.email_token}`;
      const html = getVerificationEmailHTML({
        name: user.first_name,
        url: verificationUrl
      });

      await sendOrThrow(getResend(), {
        ...platformSender('verify'),
        to: email,
        subject: 'Verify your email at School Mule',
        html
      });

      return res.status(200).json({
        success: true,
        message: "Verification email sent successfully"
      });
    } catch (error) {
      logger.error({ err: error }, "Verification email error");
      throw { status: error.status || 500, message: error.message || "Failed to send verification email" };
    }
  };

  const verifyEmail = async (req, res) => {
    const { token } = req.query;
  
    if (!token) {
      throw { status: 400, message: "Missing email token" };
    }
  
    try {
      const result = await db.query(userQueries.verifyEmailToken, [token]);
  
      if (result.rowCount === 0) {
        // Nothing flipped: either the link was already used (a second click,
        // a mail scanner's prefetch, a re-run effect) or it never existed.
        const existing = await db.query(userQueries.selectByEmailToken, [token]);
        if (existing.rowCount === 0) {
          throw { status: 400, message: "This verification link is invalid or has already been used. Try signing in." };
        }
        // Already verified: say so, and send no emails a second time.
        return res.status(200).json({
          success: true,
          message: "Email already verified",
          data: { alreadyVerified: true }
        });
      }
  
      const user = result.rows[0];

      // The verification itself succeeded above; the emails can't undo it.
      await notifyAccountVerified(user);

      return res.status(200).json({
        success: true,
        message: "Email verified successfully",
        data: {
          alreadyVerified: false,
          id: user.user_id,
          email: user.email,
          username: user.username,
          isVerified: user.is_verified
        }
      });
    } catch (error) {
      logger.error({ err: error }, "Email verification failed");
      throw { status: error.status || 500, message: error.message || "Failed to verify email" };
    }
  };

// The old Approvals page called these two; they now run the same actions as
// POST /api/admin/approvals/:id/approve|decline and keep the {success} shape.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const legacyApprovalRoute = (verb, run) => async (req, res) => {
  const { userId } = req.body ?? {};
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  try {
    const result = await run(req, userId);
    return res.status(200).json({
      success: true,
      message: result.emailSent ? `User ${verb} and email sent` : `User ${verb}, but the email could not be sent`,
      emailSent: result.emailSent,
    });
  } catch (error) {
    if (error instanceof approvalActions.ApprovalError) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    logger.error({ err: error }, `Failed to run legacy ${verb} route`);
    return res.status(500).json({ success: false, message: `Failed to ${verb === 'approved' ? 'approve' : 'decline'} user` });
  }
};

const approveUserForSchool = legacyApprovalRoute('approved', (req, userId) =>
  approvalActions.approveSignup({ school: req.user.school, userId })
);

const getPendingApprovals = async (req, res) => {
  // Always the admin's own school; a ?school= param is ignored.
  const school = req.user?.school;

  if (!school) {
    return res.status(400).json({
      success: false,
      message: 'Missing school identifier',
    });
  }

  try {
    const result = await db.query(userQueries.getPendingSchoolApprovals, [school]);

    return res.status(200).json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch pending approvals");
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending approvals',
    });
  }
};

const resendSchoolApprovalEmail = async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await db.query(userQueries.resendSchoolApprovalEmail, [userId, req.user.school]);

    if (result.rows.length === 0) {
      throw { status: 404, message: "User not found or already approved" };
    }

    const user = result.rows[0];
    const html = getApprovalEmailHTML({ name: user.username });

    await sendOrThrow(getResend(), {
      ...platformSender('verify'),
      to: user.email,
      subject: 'Reminder: Your School Mule Account Was Approved',
      html,
    });

    return res.status(200).json({
      success: true,
      message: "Approval email resent successfully",
    });

  } catch (error) {
    logger.error({ err: error }, "Failed to resend approval email");
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to resend approval email",
    });
  }
};

const deleteUserAccount = async (req, res) => {
  // Self-service only: the account to delete comes from the verified token, never
  // from the request body. Trusting a body-supplied userId here would let any
  // authenticated caller delete someone else's account.
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

  try {
    const result = await db.query(userQueries.deleteUser, [userId]);

    if (result.rowCount === 0) {
      throw { status: 404, message: "User not found" };
    }

    return res.status(200).json({
      success: true,
      message: "User account deleted",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete user account");
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to delete user",
    });
  }
};

const declineUserForSchool = legacyApprovalRoute('declined', (req, userId) =>
  approvalActions.declineSignup({ school: req.user.school, userId, adminId: req.user.userId })
);

const logout = async (req, res) => {
  res.clearCookie('user_id');
  res.clearCookie('is_verified_email');
  res.clearCookie('is_verified_school');

  return res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
};

const requestPasswordReset = async (req, res) => {
  const typed = typedEmail(req.body?.email);

  try {
    // Same match as sign-in. The link always goes to the stored address.
    const userResult = await db.query(userQueries.selectByEmailIgnoringCase, [typed]);
    const match = matchAccountByEmail(userResult.rows, typed);
    if (match.ambiguous) {
      return res.status(409).json({ success: false, code: AMBIGUOUS_EMAIL.code, message: AMBIGUOUS_EMAIL.message });
    }
    if (!match.user) {
      return res.status(404).json({ success: false, message: 'No user found with this email.' });
    }

    const user = match.user;
    // Same answer as sign-in: an archived account gets no link to use.
    if (user.is_archived) {
      return res.status(403).json({ success: false, code: 'ACCOUNT_ARCHIVED', message: ARCHIVED_MESSAGE });
    }
    if (user.role === 'STUDENT') {
      const verdict = await studentPasswordVerdict(user);
      if (verdict) return res.status(verdict.status).json({ success: false, code: verdict.code, message: verdict.message });
    }

    const tokenResult = await db.query(passwordQueries.createPasswordResetToken, [user.user_id]);
    const token = tokenResult.rows[0].token;

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    await sendResetEmail(user, resetLink);

    res.json({ success: true, message: 'Password reset email sent.' });
  } catch (err) {
    logger.error({ err }, "Password reset request failed");
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const sendResetEmail = async (user, url) => {
  const html = getResetEmailHTML({ name: user.first_name?.trim() || 'there', url });
  await sendOrThrow(getResend(), {
    ...platformSender('reset'),
    to: user.email,
    subject: 'Reset your password',
    html
  });
};

const RESET_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The code lets the page tell a dead link from a refused password.
const INVALID_RESET_TOKEN = { success: false, code: 'RESET_LINK_INVALID', message: 'Invalid or expired token.' };

/**
 * The account a password link opens, as { user }, or the refusal as
 * { status, body }. The page checks the link before asking for a password
 * and again on submit, and both answer the same: an unknown, expired or used
 * link and an archived account are a dead link, and a student in a
 * Google-only school is told to use Google.
 */
const resetLinkVerdict = async (token) => {
  if (typeof token !== 'string' || !RESET_TOKEN_RE.test(token)) return { status: 400, body: INVALID_RESET_TOKEN };

  const tokenResult = await db.query(passwordQueries.validatePasswordResetToken, [token]);
  if (tokenResult.rowCount === 0) return { status: 400, body: INVALID_RESET_TOKEN };

  const { rows: [user] } = await db.query(userQueries.selectById, [tokenResult.rows[0].user_id]);
  // An archived account keeps its records but never gets a new password.
  if (!user || user.is_archived) return { status: 400, body: INVALID_RESET_TOKEN };

  if (user.role === 'STUDENT') {
    const settings = await getClassroomSettings(user.school);
    if (settings.studentSignIn === 'google_only') {
      return {
        status: PASSWORD_SIGN_IN_OFF.status,
        body: { success: false, code: PASSWORD_SIGN_IN_OFF.code, message: PASSWORD_SIGN_IN_OFF.message },
      };
    }
  }
  return { user };
};

const validateResetToken = async (req, res) => {
  try {
    const verdict = await resetLinkVerdict(req.query.token);
    if (!verdict.user) return res.status(verdict.status).json(verdict.body);

    // Students choose a password under the invite's stricter rule; the page
    // shows it before they type.
    res.json({
      success: true,
      message: 'Token is valid.',
      data: { passwordRule: verdict.user.role === 'STUDENT' ? 'student' : 'standard' },
    });
  } catch (err) {
    logger.error({ err }, "Reset token validation failed");
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (typeof token !== 'string' || !RESET_TOKEN_RE.test(token)) return res.status(400).json(INVALID_RESET_TOKEN);
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  try {
    const verdict = await resetLinkVerdict(token);
    if (!verdict.user) return res.status(verdict.status).json(verdict.body);
    const { user } = verdict;

    // Students follow the invite's password policy.
    if (user.role === 'STUDENT') {
      const problem = passwordProblem(newPassword, { email: user.email, firstName: user.first_name, lastName: user.last_name });
      if (problem) return res.status(400).json({ success: false, code: 'PASSWORD_WEAK', message: problem });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query(userQueries.updatePassword, [hashedPassword, user.user_id]);
    // Every open link of this user dies, not just the one used.
    await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.user_id]);

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    logger.error({ err }, "Password reset failed");
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const validateSession = async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'No token provided'
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Optional: Verify user still exists in database (recommended for security)
    const result = await db.query(userQueries.selectById, [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token - user not found'
      });
    }

    const user = result.rows[0];

    // Archived mid-session: the token is still valid, so end the session here.
    if (user.is_archived) {
      return res.status(401).json({
        success: false,
        message: 'This account has been archived'
      });
    }

    // The sign-in gate again: a school that turns classrooms off, an
    // unlinked or withdrawn student... ends the open session (401 + code, so
    // the client signs out and can say why).
    if (user.role === 'STUDENT') {
      let gate;
      try {
        gate = await assertStudentCanSignIn(user);
      } catch (v) {
        if (!v || !v.code) throw v;
        return res.status(401).json({ success: false, code: v.code, message: v.message });
      }
      // Sessions from before an address change end (student invitations).
      if (sessionRevoked(decoded.iat, gate.sessionsRevokedAt)) {
        return res.status(401).json({ success: false, code: 'SESSION_REVOKED', message: STUDENT_MESSAGES.SESSION_REVOKED });
      }
      // A session opened with a QR card ends once that card is voided or reprinted.
      if (!qrCardLive(decoded.qrCard, gate)) {
        return res.status(401).json({ success: false, code: 'QR_INVALID', message: STUDENT_MESSAGES.QR_INVALID });
      }
    }

    // Same rule as login: an admin is always verified. Repair a row that
    // predates the login fix so this check and the token can't disagree.
    if (user.role === 'ADMIN' && (!user.is_verified || !user.is_verified_school)) {
      await db.query(userQueries.markAdminVerified, [user.user_id]);
      logger.info({ userId: user.user_id, school: user.school }, "Admin account marked verified at session check");
      user.is_verified = true;
      user.is_verified_school = true;
    }
    
    // Get active term for the user's school
    const activeTerm = await getActiveTermForSchool(user.school);
    const yearContext = await getSchoolYearContext(user.school);
    const roles = await getRolesForUser(user);

    // Approval, a role change, or a parent link removed after sign-in leaves
    // the token's claims behind the database. Reissue so an open app recovers
    // without a sign-out. The active view survives a reissue as long as the
    // user still holds it (a teacher in parent view stays in parent view);
    // otherwise they land back in the database role. Never for a preview
    // token: that must stay the admin's.
    const viewStillHeld = roles.includes(decoded.role);
    const claimsDrifted =
      !decoded.impersonator &&
      (decoded.isVerified !== user.is_verified ||
        decoded.isVerifiedSchool !== user.is_verified_school ||
        !viewStillHeld ||
        (decoded.baseRole ?? decoded.role) !== user.role);
    const role = viewStillHeld ? decoded.role : user.role;
    const refreshedToken = claimsDrifted ? signSessionToken({ user, role, roles, activeTerm, qrCard: decoded.qrCard }) : undefined;
    const photoUrl = await photoUrlFor(user);

    return res.status(200).json({
      success: true,
      message: 'Session valid',
      data: {
        // Present only when the claims drifted; the client stores it.
        ...(refreshedToken && { token: refreshedToken }),
        ...sessionIdentity(user, role, roles, photoUrl),
        ...(await sessionAccessFor(user, role)),
        activeTerm: activeTerm ? activeTerm.name : false,
        activeSchoolYear: yearContext.activeSchoolYear,
        schoolYears: yearContext.schoolYears,
        // Present only on an admin "view as" preview token (see adminUser.controller
        // impersonateUser) so a page reload can restore the preview banner.
        impersonator: decoded.impersonator ?? null
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    } else {
      logger.error({ err: error }, "Session validation error");
      return res.status(500).json({
        success: false,
        message: 'Session validation failed'
      });
    }
  }
};

const KNOWN_VIEWS = ['ADMIN', 'TEACHER', 'PARENT'];

// POST /api/auth/view  { view: 'ADMIN' | 'TEACHER' | 'PARENT' }
// Reissues the caller's session token with `role` set to the requested view.
// The check is server-side and current: a view is granted only if
// getRolesForUser lists it right now, so a stale or edited `roles` claim buys
// nothing. The database role is always listed, which is how an admin or
// teacher leaves the parent view; nobody is ever granted ADMIN by this route
// unless ADMIN is already their database role. Preview tokens never get here
// (verifyUser refuses their POSTs). Mirrors /auth/login so the client can
// hydrate its stores the same way.
const switchView = async (req, res) => {
  const view = req.body?.view;
  if (!KNOWN_VIEWS.includes(view)) {
    return res.status(400).json({ status: 'failed', message: 'Choose a view to switch to' });
  }

  try {
    const { rows } = await db.query(userQueries.selectById, [req.user.userId]);
    const user = rows[0];
    if (!user || user.is_archived) {
      return res.status(401).json({ status: 'failed', message: 'Session is no longer valid' });
    }

    const activeTerm = await getActiveTermForSchool(user.school);
    const yearContext = await getSchoolYearContext(user.school);
    const roles = await getRolesForUser(user);
    if (!roles.includes(view)) {
      return res.status(403).json({ status: 'failed', message: "You don't have that view on this account" });
    }

    logger.info({ userId: user.user_id, school: user.school, from: req.user.role, to: view }, 'User switched view');
    const photoUrl = await photoUrlFor(user);

    return res.status(200).json({
      status: 'success',
      message: view === 'PARENT' ? "You're now in Parent view" : `You're back in ${view === 'ADMIN' ? 'Administrator' : 'Teacher'} view`,
      data: {
        ...sessionIdentity(user, view, roles, photoUrl),
        ...(await sessionAccessFor(user, view)),
        activeTerm: activeTerm ? activeTerm.name : false,
        activeSchoolYear: yearContext.activeSchoolYear,
        schoolYears: yearContext.schoolYears,
        token: signSessionToken({ user, role: view, roles, activeTerm, qrCard: req.user.qrCard }),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to switch view');
    return res.status(500).json({ status: 'failed', message: 'Error switching view' });
  }
};

module.exports = {
    // Shared with the student invite acceptance (controllers/studentInvite.controller.js).
    openSession,
    unusablePasswordHash,
    registerUser,
    login,
    googleSignIn,
    studentQrLogin,
    switchView,
    sendVerificationEmail,
    verifyEmail,
    approveUserForSchool,
    getPendingApprovals,
    resendSchoolApprovalEmail,
    deleteUserAccount,
    declineUserForSchool,
    logout,
    requestPasswordReset,
    validateResetToken,
    resetPassword,
    validateSession
}