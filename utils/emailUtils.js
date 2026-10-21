// utils/emailUtils.js
//
// Shared helpers for every Resend send: the one Resend client, recipient
// cleaning, and the send wrappers that make a rejected email visible.
//
// Every email, whatever school it is for, goes through the single SchoolMule
// Resend team: that team holds schoolmule.ca and any school's own verified
// domain. Who the email appears to come from is decided by
// services/email/senderIdentity.js, not by which key is used.

const { Resend } = require('resend');
const logger = require('../logger');

// Domains that can never take mail (RFC 2606, RFC 6761). Test tenants such as
// PLAYGROUND give their synthetic people these addresses, so a send to one is
// dropped here instead of bouncing through Resend and hurting the sender's
// reputation.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/i;

const isReservedAddress = (recipient) => {
  const match = /@([^@<>\s]+)>?\s*$/.exec(typeof recipient === 'string' ? recipient.trim() : '');
  return Boolean(match) && RESERVED_DOMAIN.test(match[1]);
};

const asList = (value) => (value == null ? [] : [].concat(value));

// Patches a Resend client's emails.send so reserved recipients are dropped. A
// send left with no "to" takes its real cc as the "to" (never its bcc, which
// would show those addresses to each other); one left with no "to" answers
// like an accepted send, so every caller treats it as delivered.
const withReservedDomainGuard = (resend) => {
  const send = resend.emails.send.bind(resend.emails);
  resend.emails.send = async (payload) => {
    const fields = ['to', 'cc', 'bcc'].filter((field) => payload[field] != null);
    const suppressed = fields.flatMap((field) => asList(payload[field]).filter(isReservedAddress));
    if (!suppressed.length) return send(payload);

    const kept = Object.fromEntries(
      fields.map((field) => [field, asList(payload[field]).filter((r) => !isReservedAddress(r))]),
    );
    if (!kept.to?.length) {
      kept.to = kept.cc || [];
      if (kept.cc) kept.cc = [];
    }
    logger.info({ suppressed, subject: payload.subject }, 'Email to reserved test domain not sent');
    if (!kept.to.length) return { data: { id: 'suppressed' }, error: null };
    return send({ ...payload, ...kept });
  };
  return resend;
};

// One client for the whole process. Constructed lazily so a missing key only
// fails at send time, not at boot of a worker that may never send. Tests and
// local smoke stacks that capture mail set EMAIL_DELIVER_RESERVED_DOMAINS=true
// to get the raw client.
let client = null;
const getResend = () => {
  if (!client) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    client = process.env.EMAIL_DELIVER_RESERVED_DOMAINS === 'true' ? resend : withReservedDomainGuard(resend);
  }
  return client;
};

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

// Resend's SDK resolves with { error } on API failures (403/422/429) instead
// of throwing. Throw so callers' existing catch blocks see a rejected email.
// Resend's statusCode is deliberately not copied to err.status, or the error
// handler would answer the client with Resend's HTTP status.
const sendOrThrow = async (resend, payload) => {
  const result = await resend.emails.send(payload);
  if (result?.error) {
    const err = new Error(result.error.message || 'Email sending failed');
    err.name = 'ResendError';
    err.resend = result.error;
    throw err;
  }
  return result;
};

// Send, log any failure with `context`, and report success as a boolean. For
// courtesy emails that must never fail the request they ride on.
const sendSafely = async (resend, payload, message, context = {}) => {
  try {
    await sendOrThrow(resend, payload);
    return true;
  } catch (err) {
    logger.error({ err, ...context }, message);
    return false;
  }
};

module.exports = {
  cleanEmailArray,
  getResend,
  isReservedAddress,
  sendOrThrow,
  sendSafely,
  withReservedDomainGuard,
};
