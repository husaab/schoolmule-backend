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

// One client for the whole process. Constructed lazily so a missing key only
// fails at send time, not at boot of a worker that may never send.
let client = null;
const getResend = () => {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
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
  sendOrThrow,
  sendSafely,
};
