// services/meetings/ics.js
//
// Calendar files for a family's meetings (RFC 5545), attached to the
// confirmation email. Times are UTC instants of the Toronto wall clock, so
// every calendar app shows them right. Each meeting keeps its UID (the
// booking id) and SEQUENCE (bumped on every move), so opening a later file
// updates the event instead of adding a second one; a cancellation is its
// own file with METHOD:CANCEL.

const { torontoAt } = require('./time');

const escapeText = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/([;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/**
 * @param {object} p
 * @param {'PUBLISH'|'CANCEL'} p.method
 * @param {Array<{ uid, sequence, date, start, end, summary, location?, description? }>} p.events
 * @param {Date} [p.now]
 * @returns {string}
 */
function calendarFile({ method = 'PUBLISH', events, now = new Date(), name = 'Parent–teacher meetings' }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SchoolMule//Parent-teacher meetings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@ptm.schoolmule.ca`,
      `SEQUENCE:${e.sequence || 0}`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${utc(torontoAt(e.date, e.start))}`,
      `DTEND:${utc(torontoAt(e.date, e.end))}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { calendarFile, escapeText };
