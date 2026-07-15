// templates/agendaMonthOverviewTemplate.js
//
// Month overview page: title, Sun-Sat calendar grid (weekends shaded,
// event days marked), then "Days to Remember" (school calendar events)
// and "Things To Do" (blank ruled lines) side by side.

const { renderFooter, escapeHtml } = require('./agendaBaseTemplate');
const { monthGrid } = require('../utils/agendaCalendar');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_OVERVIEW_CSS = `
  .mo-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 26pt;
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 0.18in;
  }
  .mo-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .mo-grid th {
    border: 1px solid #666;
    padding: 5px 4px;
    font-size: 8.5pt;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    text-align: center;
  }
  .mo-grid td {
    border: 1px solid #666;
    height: 0.72in;
    vertical-align: top;
    text-align: right;
    padding: 3px 6px 0 3px;
    font-size: 10.5pt;
  }
  .mo-grid td.weekend { background: var(--shade, #e8e8e8); }
  .mo-grid td .event-dot {
    display: block;
    text-align: left;
    font-size: 6.5pt;
    line-height: 1.25;
    color: #333;
    overflow: hidden;
    max-height: 0.42in;
  }
  .mo-columns { display: flex; gap: 0.5in; margin-top: 0.28in; }
  .mo-column { flex: 1; min-width: 0; }
  .mo-column h2 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 15pt;
    font-weight: bold;
    margin-bottom: 0.12in;
  }
  .mo-line {
    border-bottom: 1px solid #c9c9c9;
    height: 0.28in;
    font-size: 9pt;
    color: #222;
    display: flex;
    align-items: flex-end;
    padding-bottom: 2px;
    overflow: hidden;
    white-space: nowrap;
  }
  .mo-line .event-date { font-weight: 600; margin-right: 6px; white-space: nowrap; }
`;

const NOTE_LINES = 9;

/** "Sep 22" or "Dec 22 – Jan 2" for range events. */
function formatEventDate(event) {
  const fmt = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    void y;
    return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`;
  };
  const start = fmt(event.startDate);
  if (event.endDate && event.endDate.slice(0, 10) !== event.startDate.slice(0, 10)) {
    return `${start} – ${fmt(event.endDate)}`;
  }
  return start;
}

/**
 * Render the month overview page.
 * @param {Object} params
 * @param {number} params.year
 * @param {number} params.month 1-12
 * @param {Array}  params.events school calendar events overlapping this month
 *                 [{ title, startDate, endDate, isSchoolClosed }]
 * @param {string} params.footerText
 * @param {number} params.pageNumber
 */
function getMonthOverviewPageHTML({ year, month, events = [], footerText, pageNumber }) {
  const grid = monthGrid(year, month);
  const pad = (n) => String(n).padStart(2, '0');

  const eventsOnDay = (day) => {
    if (!day) return [];
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    return events.filter((e) => {
      const start = e.startDate.slice(0, 10);
      const end = (e.endDate || e.startDate).slice(0, 10);
      return iso >= start && iso <= end;
    });
  };

  const gridRows = grid.map((week) => `
    <tr>
      ${week.map((cell, i) => {
        const weekend = i === 0 || i === 6;
        const dayEvents = eventsOnDay(cell.day).slice(0, 2);
        return `<td class="${weekend ? 'weekend' : ''}">
          ${cell.day ?? ''}
          ${dayEvents.map(e => `<span class="event-dot">${escapeHtml(e.title)}</span>`).join('')}
        </td>`;
      }).join('')}
    </tr>
  `).join('');

  // Sort by start date for the Days to Remember list; dedupe multi-day
  // events (they appear once with their range).
  const monthEvents = [...events].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const rememberLines = [];
  for (let i = 0; i < NOTE_LINES; i++) {
    const event = monthEvents[i];
    if (event && i < NOTE_LINES - 1) {
      rememberLines.push(`
        <div class="mo-line">
          <span class="event-date">${escapeHtml(formatEventDate(event))}</span>
          <span>${escapeHtml(event.title)}</span>
        </div>`);
    } else if (event && i === NOTE_LINES - 1 && monthEvents.length > NOTE_LINES) {
      rememberLines.push(`<div class="mo-line"><span>+${monthEvents.length - NOTE_LINES + 1} more — see school calendar</span></div>`);
    } else {
      rememberLines.push('<div class="mo-line"></div>');
    }
  }

  const todoLines = Array.from({ length: NOTE_LINES }, () => '<div class="mo-line"></div>').join('');

  return `
  <div class="page">
    <h1 class="mo-title">${MONTH_NAMES[month - 1]}&nbsp;&nbsp;${year}</h1>
    <table class="mo-grid">
      <thead>
        <tr>
          <th>Sunday</th><th>Monday</th><th>Tuesday</th><th>Wednesday</th>
          <th>Thursday</th><th>Friday</th><th>Saturday</th>
        </tr>
      </thead>
      <tbody>${gridRows}</tbody>
    </table>
    <div class="mo-columns">
      <div class="mo-column">
        <h2>Days to Remember</h2>
        ${rememberLines.join('')}
      </div>
      <div class="mo-column">
        <h2>Things To Do</h2>
        ${todoLines}
      </div>
    </div>
    ${renderFooter(footerText, pageNumber)}
  </div>`;
}

module.exports = { getMonthOverviewPageHTML, MONTH_OVERVIEW_CSS, MONTH_NAMES };
