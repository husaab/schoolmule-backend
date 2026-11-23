// utils/phone.js
// A phone number as someone typed it: tidied and checked, never reformatted
// (416-555-0100, (416) 555 0100 ext 12, +1 416 555 0100). The web and app
// check the same way (src/lib/meetings.ts cleanPhone).

const PHONE_RE = /^\+?[0-9().\-\s]+(?:\s*(?:x|ext\.?)\s*[0-9]+)?$/i;

/** The number tidied (spaces collapsed, trimmed), or null if it isn't one. */
function cleanPhone(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const digits = text.replace(/\D/g, '').length;
  if (text.length > 40 || digits < 7 || digits > 20 || !PHONE_RE.test(text)) return null;
  return text;
}

/**
 * An optional number from a request body: { provided: false } when the key
 * is absent, { value: null } to clear it, { error } when it isn't a number.
 */
function readPhone(body, key = 'phone') {
  if (!body || !Object.prototype.hasOwnProperty.call(body, key)) return { provided: false };
  const raw = body[key];
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { provided: true, value: null };
  if (typeof raw !== 'string') return { error: 'Enter a phone number' };
  const value = cleanPhone(raw);
  if (!value) return { error: 'That doesn’t look like a full phone number' };
  return { provided: true, value };
}

module.exports = { cleanPhone, readPhone };
