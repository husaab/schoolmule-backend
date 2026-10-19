const rateLimit = require('express-rate-limit');
const logger = require('../logger');

// Strict rate limiter for signup - 5 per hour per IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: {
    success: false,
    message: 'Too many accounts created from this IP. Please try again in an hour.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  }
});

// Rate limiter for verification emails - 3 per 15 minutes per IP
const verificationEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  message: {
    success: false,
    message: 'Too many verification email requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Admin "Resend email" on the Approvals page - 20 per 15 minutes per admin.
// Its own counter: sharing the public limiter (3 per IP) would lock an admin
// out after three stuck signups, or when a parent on the school network
// resends their own.
const adminVerificationResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    status: 'failed',
    message: 'Too many verification emails sent. Please try again in a few minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip
});

// Rate limiter for password reset - 3 per 15 minutes per IP
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  message: {
    success: false,
    message: 'Too many password reset requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter for contact form - 5 per hour per IP
const contactFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: {
    success: false,
    message: 'Too many contact form submissions. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// ─── Sign-in limits (/api/auth/login, /google, /student-qr) ────────────────
//
// A whole school signs in from one public IP (the school network's NAT): a
// class of 25 scanning QR cards or typing passwords at the start of a lesson
// must all get in. So successful sign-ins never count, and guessing is
// throttled per account:
//   - loginAccountLimiter / qrCardLimiter: 10 FAILED attempts per 15 minutes
//     per network per account (the email typed, or the card's user id). That
//     is the old per-IP budget, now for each account, so guessing one
//     account is exactly as slow as before.
//   - loginLimiter: 100 FAILED sign-ins per 15 minutes per network, across
//     every account and every sign-in route, so one network can't spray
//     guesses at many accounts.
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const TOO_MANY_SIGN_INS = {
  success: false,
  message: 'Too many login attempts. Please try again later.'
};
// A card token's user id, bare or in the scanned payload (SCHOOLMULE-QR:<token>).
const UUID_PREFIX_RE = /^(?:SCHOOLMULE-QR:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i;

const failedSignInLimiter = ({ max, key }) => rateLimit({
  windowMs: SIGN_IN_WINDOW_MS,
  max,
  // Only failures count (status >= 400): a classroom's successful sign-ins
  // from one network never use up anyone's budget.
  skipSuccessfulRequests: true,
  message: TOO_MANY_SIGN_INS,
  standardHeaders: true,
  legacyHeaders: false,
  ...(key && { keyGenerator: (req) => `${req.ip}|${key(req)}` }),
});

// The account a password sign-in is for: the address as typed, normalised.
const typedEmail = (req) => {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `email:${email}`;
};
// The account a QR card is for: its user id (malformed tokens share one bucket).
const cardUser = (req) => {
  const m = UUID_PREFIX_RE.exec(String((req.body && req.body.token) || '').trim());
  return m ? `card:${m[1].toLowerCase()}` : 'card:invalid';
};

// Per network, failed sign-ins on every route (see above).
const loginLimiter = failedSignInLimiter({ max: 100 });
// Per network and account, failed password sign-ins.
const loginAccountLimiter = failedSignInLimiter({ max: 10, key: typedEmail });
// Per network and card, failed QR sign-ins.
const qrCardLimiter = failedSignInLimiter({ max: 10, key: cardUser });
// Per network, failed student invite checks and acceptances (unknown, dead
// or refused links). An invite secret is 256 random bits, so this only keeps
// a page that is being hammered quiet.
const inviteTokenLimiter = failedSignInLimiter({ max: 20, key: () => 'invite' });
// Per network, failed uses of password links (unknown, expired or refused).
const resetTokenLimiter = failedSignInLimiter({ max: 20, key: () => 'reset' });

// Honeypot validation middleware (for contact form)
// Expects a hidden field named 'website' that should be empty
const honeypotValidation = (req, res, next) => {
  const { website, url, homepage } = req.body;

  // If any honeypot field is filled, it's likely a bot
  if (website || url || homepage) {
    logger.warn(`Honeypot triggered from IP: ${req.ip}`, {
      ip: req.ip,
      honeypotFields: { website, url, homepage }
    });

    // Return 200 to not tip off the bot, but don't process the request
    return res.status(200).json({
      success: true,
      message: 'Request processed successfully'
    });
  }

  next();
};

// Input validation to block suspicious patterns (for contact form)
const validateInput = (req, res, next) => {
  const { name, message } = req.body;

  const fieldsToCheck = [name, message].filter(Boolean);

  // Patterns that indicate spam/bot activity
  const urlPattern = /(bit\.ly|tinyurl|goo\.gl|t\.co|ow\.ly|buff\.ly|is\.gd)/i;
  const excessiveEmojiPattern = /(\p{Emoji}.*){5,}/u;

  for (const field of fieldsToCheck) {
    if (typeof field !== 'string') continue;

    // Check for URL shorteners in fields (suspicious)
    if (urlPattern.test(field)) {
      logger.warn(`Suspicious URL shortener from IP: ${req.ip}`, {
        ip: req.ip,
        pattern: 'url_shortener'
      });
      return res.status(400).json({
        success: false,
        message: 'Invalid content detected'
      });
    }

    // Check for excessive emojis
    if (excessiveEmojiPattern.test(field)) {
      logger.warn(`Excessive emojis from IP: ${req.ip}`, {
        ip: req.ip,
        pattern: 'emoji'
      });
      return res.status(400).json({
        success: false,
        message: 'Invalid content detected'
      });
    }
  }

  next();
};

module.exports = {
  signupLimiter,
  verificationEmailLimiter,
  adminVerificationResendLimiter,
  passwordResetLimiter,
  contactFormLimiter,
  loginLimiter,
  loginAccountLimiter,
  qrCardLimiter,
  inviteTokenLimiter,
  resetTokenLimiter,
  honeypotValidation,
  validateInput
};
