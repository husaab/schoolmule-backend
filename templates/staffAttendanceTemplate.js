const getStaffAttendanceHTML = (data) => {
  const { school, month, teachers, workingDays } = data;

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
    dayHeaders.push({ day: d, isWeekend });
  }

  const teacherRows = teachers
    .map((t) => {
      const recordMap = {};
      t.records.forEach((r) => {
        const d = new Date(r.attendanceDate).getDate();
        recordMap[d] = r.status;
      });

      const presentCount = t.records.filter((r) => r.status === "PRESENT").length;
      const absentCount = t.records.filter((r) => r.status === "ABSENT").length;

      const cells = dayHeaders
        .map((dh) => {
          const status = recordMap[dh.day];
          let bg = dh.isWeekend ? "#f1f5f9" : "#ffffff";
          let text = "";
          if (status === "PRESENT") {
            bg = "#dcfce7";
            text = "P";
          } else if (status === "ABSENT") {
            bg = "#fee2e2";
            text = "A";
          }
          return `<td style="padding:4px;text-align:center;font-size:11px;background:${bg};border:1px solid #e2e8f0;">${text}</td>`;
        })
        .join("");

      return `
        <tr>
          <td style="padding:6px 8px;font-size:12px;font-weight:500;border:1px solid #e2e8f0;white-space:nowrap;">
            ${t.firstName || ""} ${t.lastName || t.username || ""}
          </td>
          ${cells}
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#dcfce7;border:1px solid #e2e8f0;">${presentCount}</td>
          <td style="padding:4px;text-align:center;font-size:11px;font-weight:600;background:#fee2e2;border:1px solid #e2e8f0;">${absentCount}</td>
        </tr>
      `;
    })
    .join("");

  const dayHeaderCells = dayHeaders
    .map(
      (dh) =>
        `<th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:${
          dh.isWeekend ? "#f1f5f9" : "#f8fafc"
        };border:1px solid #e2e8f0;min-width:24px;">${dh.day}</th>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4 landscape; margin: 20px; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; color: #1e293b; }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { font-size: 20px; margin: 0 0 4px; }
    .header p { font-size: 13px; color: #64748b; margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    .legend { display: flex; gap: 16px; justify-content: center; margin: 16px 0 8px; font-size: 12px; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-box { width: 16px; height: 16px; border-radius: 3px; border: 1px solid #e2e8f0; }
    .summary { margin-top: 16px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Staff Attendance Report</h1>
    <p>${school} &mdash; ${monthName}</p>
  </div>

  <div class="legend">
    <div class="legend-item"><div class="legend-box" style="background:#dcfce7;"></div> Present</div>
    <div class="legend-item"><div class="legend-box" style="background:#fee2e2;"></div> Absent</div>
    <div class="legend-item"><div class="legend-box" style="background:#f1f5f9;"></div> Weekend</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="padding:6px 8px;text-align:left;font-size:12px;font-weight:600;background:#f8fafc;border:1px solid #e2e8f0;min-width:120px;">Teacher</th>
        ${dayHeaderCells}
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#dcfce7;border:1px solid #e2e8f0;">P</th>
        <th style="padding:4px;text-align:center;font-size:10px;font-weight:600;background:#fee2e2;border:1px solid #e2e8f0;">A</th>
      </tr>
    </thead>
    <tbody>
      ${teacherRows}
    </tbody>
  </table>

  <div class="summary">
    Working days in ${monthName}: <strong>${workingDays}</strong> &nbsp;|&nbsp; Teachers: <strong>${teachers.length}</strong>
  </div>
</body>
</html>`;
};

module.exports = { getStaffAttendanceHTML };
