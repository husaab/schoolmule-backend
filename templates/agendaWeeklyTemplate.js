// templates/agendaWeeklyTemplate.js
//
// Weekly planner page: header (month label + rotating quote), then five
// Monday-Friday rows with a boxed date number and ruled writing lines.
// Days outside the month render a blank date box (matching the printed
// agenda's boundary weeks). School-closed calendar days show a banner.

const { renderFooter, escapeHtml } = require('./agendaBaseTemplate');
const { MONTH_NAMES } = require('./agendaMonthOverviewTemplate');

const WEEKLY_CSS = `
  .wk-header {
    display: flex;
    align-items: baseline;
    gap: 0.25in;
    margin-bottom: 0.12in;
    min-height: 0.35in;
  }
  .wk-month {
    font-size: 9pt;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .wk-quote {
    flex: 1;
    text-align: center;
    font-size: 9pt;
    color: #555;
    font-style: italic;
    overflow: hidden;
    max-height: 0.35in;
  }
  .wk-quote .attribution { font-style: normal; font-size: 8pt; }
  .wk-day { display: flex; height: 1.78in; }
  .wk-day-label { width: 0.95in; flex-shrink: 0; padding-top: 2px; }
  .wk-day-label .weekday {
    display: block;
    font-size: 7.5pt;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-top: 2px solid #333;
    padding-top: 3px;
  }
  .wk-day-label .date-box {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0.42in;
    height: 0.42in;
    margin-top: 5px;
    background: var(--shade, #e8e8e8);
    border-radius: 4px;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 17pt;
  }
  .wk-day-lines { flex: 1; border-top: 1px solid #999; position: relative; }
  .wk-line { border-bottom: 1px dotted #b5b5c9; height: 0.29in; }
  .wk-closed-banner {
    position: absolute;
    top: 0.06in;
    left: 0.1in;
    right: 0.1in;
    background: var(--shade, #ececec);
    border: 1px solid #cfcfcf;
    border-radius: 4px;
    text-align: center;
    font-size: 9pt;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #666;
    padding: 4px 0;
  }
`;

const LINES_PER_DAY = 5;

/**
 * Render one weekly planner page.
 * @param {Object} params
 * @param {number} params.year   month's year (for labels)
 * @param {number} params.month  1-12 (the section month; boundary days may differ)
 * @param {Object} params.week   { mondayIso, days: [{ weekday, year, month, day, inMonth }] }
 * @param {string} params.quote  rotating header quote (may be empty)
 * @param {Array}  params.closedDays school-closed events overlapping this week
 *                 [{ title, startDate, endDate, isSchoolClosed }]
 * @param {string} params.footerText
 * @param {number} params.pageNumber
 */
function getWeeklyPageHTML({ month, week, quote, closedDays = [], footerText, pageNumber }) {
  const pad = (n) => String(n).padStart(2, '0');

  const closedEventFor = (day) => {
    const iso = `${day.year}-${pad(day.month)}-${pad(day.day)}`;
    return closedDays.find((e) => {
      const start = e.startDate.slice(0, 10);
      const end = (e.endDate || e.startDate).slice(0, 10);
      return iso >= start && iso <= end;
    });
  };

  const dayBlocks = week.days.map((day) => {
    const closed = day.inMonth ? closedEventFor(day) : null;
    const lines = Array.from({ length: LINES_PER_DAY }, () => '<div class="wk-line"></div>').join('');
    return `
      <div class="wk-day">
        <div class="wk-day-label">
          <span class="weekday">${escapeHtml(day.weekday)}</span>
          <span class="date-box">${day.inMonth ? day.day : ''}</span>
        </div>
        <div class="wk-day-lines">
          ${closed ? `<div class="wk-closed-banner">${escapeHtml(closed.title)} — No School</div>` : ''}
          ${lines}
        </div>
      </div>`;
  }).join('');

  const quoteHtml = quote
    ? `<span>&ldquo;${escapeHtml(quote)}&rdquo;</span>`
    : '';

  return `
  <div class="page">
    <div class="wk-header">
      <span class="wk-month">${escapeHtml(MONTH_NAMES[month - 1])}</span>
      <span class="wk-quote">${quoteHtml}</span>
    </div>
    ${dayBlocks}
    ${renderFooter(footerText, pageNumber)}
  </div>`;
}

module.exports = { getWeeklyPageHTML, WEEKLY_CSS };
