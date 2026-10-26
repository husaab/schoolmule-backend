// Clock and label formatting for "Copy with new times" — written the way
// schools write bell schedules ("8:40–8:50", "Grades 1–4").

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 520 → "8:40", 805 → "1:25" (12-hour, no am/pm). */
function clock(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
}

const timeRange = (startMin, endMin) => `${clock(startMin)}–${clock(endMin)}`;

const dayName = (day) => DAY_NAMES[day] || `Day ${day}`;

/** ["Grade 1", …, "Grade 4", "JK", "SK"] → "Grades 1–4 · JK · SK". */
function bellLabel(names) {
  const grades = [];
  const others = [];
  for (const name of names) {
    const match = /^grade\s*(\d+)$/i.exec(String(name).trim());
    if (match) grades.push(Number(match[1]));
    else others.push(name);
  }
  const unique = [...new Set(grades)].sort((a, b) => a - b);
  const runs = [];
  for (let i = 0; i < unique.length; ) {
    let j = i;
    while (j + 1 < unique.length && unique[j + 1] === unique[j] + 1) j++;
    runs.push(i === j ? `${unique[i]}` : `${unique[i]}–${unique[j]}`);
    i = j + 1;
  }
  const parts = [];
  if (runs.length) parts.push(`${unique.length === 1 ? 'Grade' : 'Grades'} ${runs.join(', ')}`);
  return [...parts, ...others].join(' · ');
}

module.exports = { clock, timeRange, dayName, bellLabel };
