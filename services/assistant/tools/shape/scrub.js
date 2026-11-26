// services/assistant/tools/shape/scrub.js
//
// The last check on anything that reaches the model or the stored
// transcript. Every tool already builds its answer from an allowlist of
// fields; this is the net under that. It removes:
//
//   - any key that names an education number, a contact detail or a health
//     note, whatever it is nested under;
//   - any nine-digit number in text (the shape of an Ontario Education
//     Number), including in what the person typed.
//
// The Education Act makes misuse of a student's education number an
// offence, and the model has no use for one, so it never leaves the school's
// database. In tests a sensitive key reaching scrubResult is a failure, not
// something to clean up quietly: it means a tool's allowlist let it through.

const SENSITIVE_KEY = /(oen|e-?mail|phone|mobile|address|postal|medical|health|allerg|diagnos|birth|dob|emergency|password|token|guardian|mother|father|contact)/i;
const NINE_DIGITS = /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g;
const REMOVED = '[removed]';

const isSensitiveKey = (key) => SENSITIVE_KEY.test(String(key)) || /(^|_)number$/i.test(String(key));

/** Text with anything shaped like an education number taken out. */
const scrubText = (text) => (typeof text === 'string' ? text.replace(NINE_DIGITS, REMOVED) : text);

function walk(value, onSensitiveKey) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, onSensitiveKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        onSensitiveKey(key);
        continue;
      }
      out[key] = walk(inner, onSensitiveKey);
    }
    return out;
  }
  return value;
}

/**
 * A tool's answer, safe to hand to the model and to store.
 * Throws in tests when a sensitive key is present (see the header).
 */
function scrubResult(value) {
  return walk(value, (key) => {
    if (process.env.NODE_ENV === 'test') {
      throw new Error(`A tool result carried the sensitive key "${key}": fix the tool's allowlist`);
    }
  });
}

module.exports = { scrubText, scrubResult, isSensitiveKey, REMOVED };
