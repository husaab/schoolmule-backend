// utils/emailUtils.js
//
// Shared helpers for the parent-facing email flows (report cards,
// progress reports, and Student View certificates). Extracted from
// reportEmails.controller.js so the certificate flow can reuse the
// exact same recipient-cleaning, API-key, and domain logic.

const logger = require('../logger');

// Clean and validate an array of email addresses: trims, drops blanks,
// and keeps only strings that contain an "@".
const cleanEmailArray = (emails) => {
  if (!emails) return [];
  if (!Array.isArray(emails)) return [];

  return emails
    .map((email) => (typeof email === 'string' ? email.trim() : ''))
    .filter((email) => email.length > 0)
    .filter((email) => email.includes('@')); // Basic email validation
};

// Resolve a school's Resend API key from the environment, e.g.
// "Al Haadi Academy" -> ALHAADIACADEMY_RESEND_API_KEY. Falls back to
// the shared RESEND_API_KEY when no school-specific key is configured.
const getSchoolApiKey = (school) => {
  const schoolKey = school
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();

  logger.info('school key is' + schoolKey);

  const apiKeyVar = `${schoolKey}_RESEND_API_KEY`;
  const schoolApiKey = process.env[apiKeyVar];

  if (!schoolApiKey) {
    return process.env.RESEND_API_KEY;
  }

  return schoolApiKey;
};

// Resolve the verified sending domain for a school. Defaults to
// schoolmule.ca for schools without their own verified domain.
const getSchoolDomain = (school) => {
  switch (school) {
    case 'ALHAADIACADEMY':
      logger.info('School Domain Found: alhaadiacademy.ca');
      return 'alhaadiacademy.ca';
    default:
      logger.info('No domain found for school');
      return 'schoolmule.ca';
  }
};

module.exports = {
  cleanEmailArray,
  getSchoolApiKey,
  getSchoolDomain,
};
