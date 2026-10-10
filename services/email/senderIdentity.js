// services/email/senderIdentity.js
//
// Who an email appears to come from, and where a reply goes. Every Resend
// send in the backend gets its `from` and `replyTo` from one of these two
// functions, so the rule lives in one place and is driven by the schools
// table instead of a hard-coded switch.
//
//   platformSender('verify')  -> SchoolMule <verify@schoolmule.ca>, replies to support
//   schoolSender(...)         -> "Al Haadi Academy" <academics@alhaadiacademy.ca>
//                                when the school has a verified sending domain,
//                                otherwise "Al Haadi Academy" <alhaadiacademy@schoolmule.ca>;
//                                replies go to the school's reply-to list + contact email.
//
// One Resend team holds every domain (schoolmule.ca plus any school's own
// verified domain), so the sender identity never implies a different API key.

const { getSchoolName } = require('../../utils/schoolUtils');
const { cleanEmailArray } = require('../../utils/emailUtils');

const PLATFORM_NAME = 'SchoolMule';

// Role local-parts a school with its own verified domain sends from.
const SCHOOL_ROLES = new Set(['academics', 'messages']);

const platformDomain = () => process.env.MAIL_DOMAIN || 'schoolmule.ca';

// RFC 5322 display name: drop characters that would break or spoof the header.
const displayName = (name) => String(name || '').replace(/["<>\\\r\n]/g, '').trim();

const formatAddress = (name, address) => {
  const safe = displayName(name);
  return safe ? `"${safe}" <${address}>` : address;
};

// "al-haadi-academy" -> "alhaadiacademy". Falls back to the enum code.
const derivedLocal = (row, school) =>
  String(row.email_sender_local || row.slug || row.school_code || school || 'school')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'school';

// Only well-formed addresses may become a Reply-To; a bad one would make Resend reject the whole send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validAddresses = (list) => Array.from(new Set(cleanEmailArray(list).map((e) => e.toLowerCase()).filter((e) => EMAIL_RE.test(e))));

/**
 * Sender identity for an email in the school's voice.
 *
 * @param {object} p
 * @param {string} p.school          school enum code, e.g. 'ALHAADIACADEMY'
 * @param {object|null} [p.schoolInfo] the schools row (selectSchoolByCode); null when the
 *                                   lookup failed, in which case the platform address is used
 * @param {'academics'|'messages'} [p.role='academics'] local part on a verified school domain
 * @returns {{ from: string, replyTo: string[]|undefined }} spread straight into a Resend payload
 */
function schoolSender({ school, schoolInfo, role = 'academics' }) {
  if (!SCHOOL_ROLES.has(role)) throw new Error(`Unknown school sender role: ${role}`);
  const row = schoolInfo || { school_code: school };
  const name = row.name || getSchoolName(school || row.school_code || '');

  const address = row.email_sending_domain
    ? `${role}@${row.email_sending_domain}`
    : `${derivedLocal(row, school)}@${platformDomain()}`;

  const replyTo = validAddresses([...(row.email_reply_to || []), row.email]);

  return { from: formatAddress(name, address), replyTo: replyTo.length ? replyTo : undefined };
}

/**
 * Sender identity for an email in SchoolMule's own voice (account mechanics,
 * ops alerts, the contact form).
 *
 * @param {string} [role='no-reply'] local part on the platform domain
 * @param {{ replyTo?: string|string[] }} [opts] override the reply address (e.g. the contact-form visitor)
 */
function platformSender(role = 'no-reply', opts = {}) {
  const address = `${role}@${platformDomain()}`;
  const replyTo = validAddresses([].concat(opts.replyTo ?? process.env.SUPPORT_EMAIL ?? []));
  return { from: formatAddress(PLATFORM_NAME, address), replyTo: replyTo.length ? replyTo : undefined };
}

// The bare address inside a From header, for display ("emails are sent from …").
const senderAddress = (from) => (String(from).match(/<([^>]+)>/) || [, String(from)])[1];

module.exports = { schoolSender, platformSender, senderAddress, SCHOOL_ROLES };
