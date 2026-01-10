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

// Rate limiter for login - 10 per 15 minutes per IP (to prevent brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

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
  passwordResetLimiter,
  contactFormLimiter,
  loginLimiter,
  honeypotValidation,
  validateInput
};
