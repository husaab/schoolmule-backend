const escHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const displayName = (t) => escHtml(`${t.firstName || ""} ${t.lastName || t.username || ""}`.trim());

/** "Sept 25, 2026" from a YYYY-MM-DD key, without any timezone shift. */
const longDate = (key) => {
  const [y, m, d] = String(key).substring(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
};

const fmtHours = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
};

const th = (text, extra = "") =>
  `<th style="padding:4px 6px;text-align:center;font-size:10px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;${extra}">${text}</th>`;
const td = (text, extra = "") =>
  `<td style="padding:4px 6px;text-align:center;font-size:11px;border:1px solid #e2e8f0;${extra}">${text}</td>`;

/**
 * One table per pay day landing in the month: hours worked in the period that
 * pay day covers. While the pay day is still ahead, the numbers run through
 * today and the heading says so.
 */
const renderPayPeriod = (period) => {
  const rows = period.teachers
    .map((t) => {
      const overrides = t.records.filter((r) => r.hours !== null && r.hours !== undefined).length;
      return `
        <tr>
          <td style="padding:5px 8px;font-size:11px;font-weight:500;border:1px solid #e2e8f0;white-space:nowrap;">${displayName(t)}</td>
          ${td(t.presentDays, "background:#dcfce7;")}
          ${td(t.absentDays, "background:#fee2e2;")}
          ${td(`${t.elapsedWorkingDays} / ${t.workingDays}`)}
          ${td(fmtHours(t.hoursPerDay) + (t.hoursPerDaySource === "custom" ? " *" : ""))}
          ${td(`<strong>${fmtHours(t.hoursWorked)}</strong>`, "background:#ecfeff;font-size:12px;")}
          ${td(overrides ? String(overrides) : "", "color:#64748b;")}
        </tr>`;
    })
    .join("");

  const totalHours = period.teachers.reduce((sum, t) => sum + (Number(t.hoursWorked) || 0), 0);
  const scope = period.isComplete
    ? `Period complete`
    : `Through ${longDate(period.throughDate)} &mdash; pay day is still ahead`;

  return `
    <div style="margin-top:22px;page-break-inside:avoid;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:6px;">
        <h2 style="font-size:14px;font-weight:600;color:#1e293b;margin:0;">
          Pay day ${longDate(period.payDate)}
          <span style="font-weight:400;color:#64748b;font-size:12px;">&nbsp;&middot;&nbsp; ${longDate(period.startDate)} &ndash; ${longDate(period.endDate)}</span>
        </h2>
        <span style="font-size:11px;color:${period.isComplete ? "#15803d" : "#b45309"};">${scope}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th style="padding:5px 8px;text-align:left;font-size:11px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;min-width:140px;">Staff member</th>
            ${th("Present", "background:#dcfce7;")}
            ${th("Absent", "background:#fee2e2;")}
            ${th("Days elapsed / scheduled")}
            ${th("Hours / day")}
            ${th("Hours worked", "background:#ecfeff;")}
            ${th("Day overrides")}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td style="padding:5px 8px;font-size:11px;font-weight:600;border:1px solid #e2e8f0;">Total</td>
            ${td("")}${td("")}${td("")}${td("")}
            ${td(`<strong>${fmtHours(totalHours)}</strong>`, "background:#ecfeff;font-size:12px;")}
            ${td("")}
          </tr>
        </tfoot>
      </table>
    </div>`;
};

const getStaffAttendanceHTML = (data) => {
  const { school, month, teachers, workingDays, schedule = null, payPeriods = [] } = data;

  // Parse month
  const [year, mon] = month.split("-");
  const monthDate = new Date(parseInt(year), parseInt(mon) - 1, 1);
  const monthName = monthDate.toLocaleString("default", { month: "long", year: "numeric" });
  const daysInMonth = new Date(parseInt(year), parseInt(mon), 0).getDate();

  // Build day headers (1..daysInMonth)
  const dayHeaders = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(parseInt(year), parseInt(mon) - 1, d);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const isoDay = date.getDay() === 0 ? 7 : date.getDay();
    dayHeaders.push({ day: d, isWeekend, isoDay });
  }

  const teacherRows = teachers
    .map((t) => {
      const recordMap = {};
      t.records.forEach((r) => {
        // Day-of-month from the date itself; parsing "YYYY-MM-DD" as a Date
        // reads it as UTC midnight and can land on the previous day.
        const d =
          r.attendanceDate instanceof Date
            ? r.attendanceDate.getDate()
            : parseInt(String(r.attendanceDate).substring(8, 10), 10);
        recordMap[d] = r;
      });
      const workDays = t.workDays || [1, 2, 3, 4, 5];

      const presentCount = t.records.filter((r) => r.status === "PRESENT").length;
      const absentCount = t.records.filter((r) => r.status === "ABSENT").length;

      const cells = dayHeaders
        .map((dh) => {
          const record = recordMap[dh.day];
          const status = record?.status;
          const hasNote = !!(record?.notes);
          const hasHours = record?.hours !== null && record?.hours !== undefined;
          const offDay = !dh.isWeekend && !workDays.includes(dh.isoDay);
          let bg = dh.isWeekend ? "#f1f5f9" : offDay ? "#f8fafc" : "#ffffff";
          let text = offDay ? '<span style="color:#cbd5e1;">–</span>' : "";
          if (status === "PRESENT") {
            bg = "#dcfce7";
            text = "P";
          } else if (status === "ABSENT") {
            bg = "#fee2e2";
            text = "A";
          }
          if (hasHours) {
            text += `<div style="font-size:8px;color:#0e7490;line-height:1;">${fmtHours(record.hours)}h</div>`;
          }
          const border = hasNote ? "2px solid #fde047" : "1px solid #e2e8f0";
          return `<td style="padding:3px 2px;text-align:center;font-size:11px;background:${bg};border:${border};">${text}</td>`;
        })
        .join("");

      return `
        <tr>
          <td style="padding:6px 8px;font-size:12px;font-weight:500;border:1px solid #e2e8f0;white-space:nowrap;">
            ${displayName(t)}
          </td>
          ${cells}
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#dcfce7;border:1px solid #e2e8f0;">${presentCount}</td>
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#fee2e2;border:1px solid #e2e8f0;">${absentCount}</td>
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;">${t.workingDays ?? workingDays}</td>
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#ecfeff;border:1px solid #e2e8f0;">${fmtHours(t.hoursWorked)}</td>
        </tr>
      `;
    })
    .join("");

  // Build notes appendix
  const notesRows = teachers
    .map((t) => {
      const notedRecords = t.records.filter((r) => r.notes);
      if (!notedRecords.length) return "";
      const lines = notedRecords
        .map((r) => {
          const dateLabel = new Date(r.attendanceDate).toLocaleDateString("default", { month: "short", day: "numeric" });
          return `<li style="margin:2px 0;">${dateLabel} (${r.status === "PRESENT" ? "P" : "A"}): ${escHtml(r.notes)}</li>`;
        })
        .join("");
      return `
        <div style="margin-bottom:8px;">
          <strong style="font-size:12px;">${displayName(t)}</strong>
          <ul style="margin:4px 0 0 16px;padding:0;font-size:11px;color:#475569;">${lines}</ul>
        </div>`;
    })
    .join("");

  const dayHeaderCells = dayHeaders
    .map(
      (dh) =>
        `<th style="padding:4px 2px;text-align:center;font-size:10px;font-weight:600;background:${
          dh.isWeekend ? "#f1f5f9" : "#f8fafc"
        };border:1px solid #e2e8f0;min-width:20px;">${dh.day}</th>`
    )
    .join("");

  const scheduleLine = schedule
    ? `Pay schedule: <strong>${escHtml(schedule.description)}</strong> &nbsp;|&nbsp; Default day: <strong>${fmtHours(schedule.defaultHoursPerDay)} h</strong>`
    : `No pay schedule configured &mdash; hours use ${fmtHours(data.schoolHoursPerDay ?? 7.5)} h per day`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4 landscape; margin: 20px; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 12px; color: #1e293b; }
    .header { text-align: center; margin-bottom: 16px; }
    .header h1 { font-size: 20px; margin: 0 0 4px; }
    .header p { font-size: 13px; color: #64748b; margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    .legend { display: flex; gap: 16px; justify-content: center; margin: 12px 0 8px; font-size: 12px; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-box { width: 16px; height: 16px; border-radius: 3px; border: 1px solid #e2e8f0; }
    .summary { margin-top: 12px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Staff Attendance Report</h1>
    <p>${escHtml(school)} &mdash; ${monthName}</p>
  </div>

  <div class="legend">
    <div class="legend-item"><div class="legend-box" style="background:#dcfce7;"></div> Present</div>
    <div class="legend-item"><div class="legend-box" style="background:#fee2e2;"></div> Absent</div>
    <div class="legend-item"><div class="legend-box" style="background:#f1f5f9;"></div> Weekend</div>
    <div class="legend-item"><div class="legend-box" style="background:#f8fafc;"></div> – Not scheduled</div>
    <div class="legend-item"><div class="legend-box" style="background:#fefce8;border-color:#fde047;"></div> Has note</div>
    <div class="legend-item"><span style="color:#0e7490;font-weight:600;">4h</span> Hours overridden</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="padding:6px 8px;text-align:left;font-size:12px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;min-width:120px;">Teacher</th>
        ${dayHeaderCells}
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#dcfce7;border:1px solid #e2e8f0;">P</th>
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#fee2e2;border:1px solid #e2e8f0;">A</th>
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;" title="Working days">Days</th>
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#ecfeff;border:1px solid #e2e8f0;" title="Hours worked this month">Hrs</th>
      </tr>
    </thead>
    <tbody>
      ${teacherRows}
    </tbody>
  </table>

  <div class="summary">
    School days in ${monthName}: <strong>${workingDays}</strong> &nbsp;|&nbsp; Teachers: <strong>${teachers.length}</strong> &nbsp;|&nbsp; ${scheduleLine}
  </div>

  ${payPeriods.length ? `
  <div style="margin-top:20px;border-top:1px solid #e2e8f0;padding-top:4px;">
    <h2 style="font-size:13px;font-weight:600;color:#1e293b;margin:12px 0 0;">Hours worked by pay day</h2>
    <p style="font-size:11px;color:#64748b;margin:2px 0 0;">Each pay period runs from the day after the previous pay day up to and including the pay day. A present day counts the person's hours per day (* = set individually by an admin); overridden days count exactly what was logged.</p>
    ${payPeriods.map(renderPayPeriod).join("")}
  </div>` : ""}

  ${notesRows ? `
  <div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:16px;">
    <h2 style="font-size:13px;font-weight:600;color:#1e293b;margin:0 0 12px;">Notes</h2>
    ${notesRows}
  </div>` : ""}
</body>
</html>`;
};

module.exports = { getStaffAttendanceHTML };
