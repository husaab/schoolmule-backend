// HTML builder for schedule PDF export: landscape Letter, one page per
// class group (or per teacher), minute-proportional day columns.

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function toHHMM(minutes) {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${period}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SESSION_COLORS = [
  '#dbeafe', '#dcfce7', '#fef9c3', '#fce7f3', '#ede9fe',
  '#ffedd5', '#cffafe', '#fee2e2', '#d1fae5', '#e0e7ff',
];

function colorFor(name, palette) {
  let hash = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

/**
 * pages: [{ title, sessions: [{ day (1-7), startMin, endMin,
 *           primaryLabel, secondaryLabel, roomName }] }]
 * days: sorted ISO ints shown as columns (shared across pages)
 * rangeStartMin/rangeEndMin: vertical time window of the grid
 */
function buildScheduleHtml({ schoolName, scheduleName, pages, days, rangeStartMin, rangeEndMin }) {
  const span = Math.max(rangeEndMin - rangeStartMin, 1);
  const topPct = (min) => (((min - rangeStartMin) / span) * 100).toFixed(3);
  const heightPct = (from, to) => (((to - from) / span) * 100).toFixed(3);

  // Hour ruler marks
  const marks = [];
  for (let m = Math.ceil(rangeStartMin / 60) * 60; m <= rangeEndMin; m += 60) {
    marks.push(m);
  }

  const pageHtml = pages
    .map((page) => {
      const columns = days
        .map((day) => {
          const daySessions = page.sessions.filter((s) => s.day === day);
          const blocks = daySessions
            .map(
              (s) => `
              <div class="session" style="top:${topPct(s.startMin)}%;height:${heightPct(s.startMin, s.endMin)}%;background:${colorFor(s.primaryLabel, SESSION_COLORS)};">
                <div class="session-name">${escapeHtml(s.primaryLabel)}</div>
                <div class="session-meta">${toHHMM(s.startMin)}–${toHHMM(s.endMin)}</div>
                ${s.secondaryLabel ? `<div class="session-meta">${escapeHtml(s.secondaryLabel)}</div>` : ''}
                ${s.roomName ? `<div class="session-meta">${escapeHtml(s.roomName)}</div>` : ''}
              </div>`
            )
            .join('');
          return `
            <div class="day-col">
              <div class="day-head">${DAY_LABELS[day - 1]}</div>
              <div class="day-body">${blocks}</div>
            </div>`;
        })
        .join('');

      const ruler = marks
        .map(
          (m) =>
            `<div class="mark" style="top:${topPct(m)}%"><span>${toHHMM(m)}</span></div>`
        )
        .join('');

      return `
        <div class="page">
          <div class="page-header">
            <div>
              <div class="school-name">${escapeHtml(schoolName)}</div>
              <div class="schedule-name">${escapeHtml(scheduleName)}</div>
            </div>
            <div class="page-title">${escapeHtml(page.title)}</div>
          </div>
          <div class="grid">
            <div class="ruler"><div class="day-head"></div><div class="ruler-body">${ruler}</div></div>
            ${columns}
          </div>
        </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: Letter landscape; margin: 0.35in; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1f2937; }
  .page { height: 7.3in; page-break-after: always; display: flex; flex-direction: column; }
  .page:last-child { page-break-after: auto; }
  .page-header { display: flex; justify-content: space-between; align-items: baseline;
                 border-bottom: 2px solid #0f766e; padding-bottom: 6px; margin-bottom: 8px; }
  .school-name { font-size: 15px; font-weight: 700; color: #0f766e; }
  .schedule-name { font-size: 10px; color: #6b7280; }
  .page-title { font-size: 18px; font-weight: 700; }
  .grid { flex: 1; display: flex; min-height: 0; }
  .ruler { width: 0.7in; display: flex; flex-direction: column; }
  .ruler-body { position: relative; flex: 1; }
  .mark { position: absolute; right: 4px; transform: translateY(-50%); }
  .mark span { font-size: 7px; color: #6b7280; }
  .day-col { flex: 1; display: flex; flex-direction: column; border-left: 1px solid #e5e7eb; }
  .day-col:last-child { border-right: 1px solid #e5e7eb; }
  .day-head { height: 20px; font-size: 10px; font-weight: 600; text-align: center;
              line-height: 20px; background: #f0fdfa; border-bottom: 1px solid #e5e7eb; }
  .day-body { position: relative; flex: 1; background:
              repeating-linear-gradient(to bottom, transparent, transparent 49px, #f3f4f6 50px); }
  .session { position: absolute; left: 2px; right: 2px; border-radius: 3px;
             border: 1px solid rgba(0,0,0,0.12); padding: 2px 4px; overflow: hidden; }
  .session-name { font-size: 8px; font-weight: 700; }
  .session-meta { font-size: 7px; color: #374151; }
</style>
</head>
<body>${pageHtml}</body>
</html>`;
}

module.exports = { buildScheduleHtml, DAY_LABELS };
