#!/usr/bin/env node
// scripts/seed/playground/generate.js
//
// Writes sql/00_reset.sql … sql/07_extras.sql: a whole synthetic school in the
// PLAYGROUND tenant's 2026-2027 year, for testing the apps against real-shaped
// data. See README.md for the accounts and how to run it.
//
// The output is deterministic (fixed PRNG seed, md5-derived ids), and every
// date is worked out in SQL from the day it runs (America/Toronto): due dates,
// what is graded and published, attendance up to today. Re-running reset + seed
// on a later day gives the school "as of" that day.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./content');
const { buildTimetable, timetableSubjects, periodsPerWeek } = require('./timetable');

const OUT = path.join(__dirname, 'sql');

// ── helpers ─────────────────────────────────────────────────────────────────
const sid = (key) => {
  const h = crypto.createHash('md5').update(`playground-seed:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const arr = (xs, type = 'text') => (xs && xs.length ? `ARRAY[${xs.map(lit).join(', ')}]::${type}[]` : `'{}'::${type}[]`);
const json = (v) => `${lit(JSON.stringify(v))}::jsonb`;
const values = (rows) => rows.map((r) => `  (${r.join(', ')})`).join(',\n');
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(20261020);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const slug = (s) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/\s+/g, '.');
const gradeLabel = (g) => (g === 'JK' || g === 'SK' ? g : `Grade ${g}`);

// ── people ──────────────────────────────────────────────────────────────────
const staff = C.STAFF.map((s) => ({
  ...s,
  id: sid(`user:${s.key}`),
  email: s.email || `${slug(s.first)}.${slug(s.last)}@${C.DOMAIN}`,
  name: `${s.first} ${s.last}`,
}));
const staffBy = Object.fromEntries(staff.map((s) => [s.key, s]));

const BOYS = ['Ali', 'Omar', 'Yusuf', 'Ibrahim', 'Zayd', 'Hamza', 'Idris', 'Musa', 'Isa', 'Hassan', 'Hussein', 'Mahdi', 'Khalid', 'Tariq', 'Sami', 'Rayan', 'Zain', 'Ayaan', 'Ilyas', 'Harun', 'Nuh', 'Kareem', 'Faris', 'Amir', 'Ismail', 'Yahya', 'Jibril', 'Anas', 'Hadi', 'Taha', 'Malik', 'Rami', 'Ziad', 'Nabil', 'Elias', 'Danyal', 'Mustafa', 'Sajjad', 'Abbas', 'Qasim', 'Jafar', 'Ammar', 'Salman', 'Mikail', 'Dawud', 'Sulaiman'];
const GIRLS = ['Maryam', 'Fatima', 'Zainab', 'Aisha', 'Noor', 'Hana', 'Amira', 'Yasmin', 'Safiya', 'Zahra', 'Aya', 'Dina', 'Rania', 'Salma', 'Inaya', 'Alya', 'Leen', 'Rahma', 'Sakina', 'Khadija', 'Asma', 'Sumaya', 'Malak', 'Jana', 'Reem', 'Talia', 'Iman', 'Ameera', 'Zara', 'Ayla', 'Mina', 'Sofia', 'Hafsa', 'Batool', 'Kawthar', 'Hawra', 'Marwa', 'Nadine', 'Lamar', 'Ruba', 'Yara', 'Celine', 'Tala', 'Haya'];
const MOTHERS = ['Rasha', 'Hanan', 'Nisreen', 'Suha', 'Widad', 'Rima', 'Lubna', 'Samar', 'Ghada', 'Dalia', 'Rehana', 'Shazia', 'Farzana', 'Sana', 'Bushra', 'Fadia', 'Hala', 'Najla', 'Ola', 'Rula', 'Yasmine', 'Zeina', 'Abeer', 'Areej', 'Basma', 'Dima', 'Ibtisam', 'Jamila', 'Lamia', 'Maha', 'Nawal', 'Raghad', 'Sawsan', 'Tahani', 'Wafa', 'Nada', 'Huda', 'Manal', 'Rabab', 'Samah'];
const FATHERS = ['Ahmed', 'Mohammed', 'Khaled', 'Walid', 'Samir', 'Fadi', 'Bassam', 'Imad', 'Jamal', 'Nabil', 'Tarek', 'Wael', 'Yasser', 'Hisham', 'Majid', 'Raed', 'Saeed', 'Talal', 'Usama', 'Zuhair', 'Adel', 'Basil', 'Faisal', 'Ghassan', 'Haitham', 'Issam', 'Kamal', 'Marwan', 'Nizar', 'Qais', 'Rafiq', 'Tamer', 'Hadi', 'Mazen', 'Anwar', 'Jawad', 'Riyad', 'Sherif'];
const SURNAMES = ['Abbas', 'Ahmed', 'Amin', 'Ansari', 'Asad', 'Awad', 'Bakr', 'Baig', 'Chaudhry', 'Daher', 'Diab', 'Elmasri', 'Fadel', 'Ghanem', 'Habib', 'Hakim', 'Hamid', 'Hussain', 'Ibrahim', 'Idris', 'Ismail', 'Jamal', 'Karimi', 'Khan', 'Latif', 'Mahmoud', 'Malik', 'Masri', 'Mirza', 'Mustafa', 'Nadeem', 'Najjar', 'Noor', 'Qureshi', 'Rahimi', 'Rashid', 'Sabri', 'Sadiq', 'Said', 'Salem', 'Shah', 'Shams', 'Sharif', 'Siddiqui', 'Suleiman', 'Taha', 'Tahir', 'Wahab', 'Yasin', 'Zaman', 'Zayed', 'Bakri', 'Hijazi', 'Jafari', 'Kazmi', 'Moussa', 'Rizvi', 'Sayed', 'Talib', 'Abidi', 'Mehdi', 'Bashir', 'Osei', 'Diallo', 'Yilmaz', 'Hodzic', 'Begum', 'Patel', 'Ayoub', 'Bitar', 'Chami', 'Dabbagh', 'Fakhoury', 'Ghandour', 'Haidar', 'Issa', 'Jaafar', 'Karam', 'Lahoud', 'Maalouf', 'Nassar', 'Obeid', 'Qassem', 'Rifai', 'Sabbagh', 'Tannous', 'Usman', 'Wazir', 'Yassine', 'Zoabi', 'Alavi', 'Bukhari', 'Durrani', 'Farooqi', 'Gilani', 'Hashmi', 'Iqbal', 'Junaid', 'Kamali', 'Lodhi', 'Mansoori', 'Naqvi'];

const STREETS = ['Maple Ave', 'Cedar Cres', 'Willow Way', 'Birchwood Dr', 'Elm St', 'Oakridge Rd', 'Pine Valley Blvd', 'Lakeshore Rd', 'Heritage Hills Dr', 'Meadowvale Blvd', 'Creditview Rd', 'Thomas St', 'Erin Mills Pkwy', 'Glen Erin Dr'];
const CITIES = ['Mississauga', 'Mississauga', 'Mississauga', 'Brampton', 'Oakville', 'Milton', 'Toronto'];
const MEDICAL = ['Peanut allergy — EpiPen in the office.', 'Asthma — inhaler in backpack.', 'Wears glasses for reading.', 'Lactose intolerant.', 'Mild eczema; cream kept in the office.'];

let phoneSeq = 0;
const phone = () => {
  const area = ['905', '416', '647', '289'][phoneSeq % 4];
  const n = `555-01${String(phoneSeq % 100).padStart(2, '0')}`;
  phoneSeq += 1;
  return `${area}-${n}`;
};
const usedEmails = new Set(staff.map((s) => s.email));
const uniqueEmail = (local, domain) => {
  let e = `${local}@${domain}`;
  for (let i = 2; usedEmails.has(e); i += 1) e = `${local}${i}@${domain}`;
  usedEmails.add(e);
  return e;
};
usedEmails.add(`parent@${C.DOMAIN}`);
usedEmails.add(`student@${C.DOMAIN}`);

const families = [];
const students = [];
const surnamePool = [...SURNAMES].sort(() => rand() - 0.5);
const newFamily = (surname, opts = {}) => {
  const fam = {
    key: slug(surname), surname, kids: [], no: families.length + 1,
    mother: opts.mother === null ? null : { first: opts.mother || pick(MOTHERS) },
    father: opts.father === null ? null : { first: opts.father || pick(FATHERS) },
  };
  families.push(fam);
  return fam;
};
const addKid = (fam, grade, first, gender) => {
  const taken = new Set(students.filter((s) => s.grade === grade || s.family === fam).map((s) => s.first));
  const pool = gender === 'm' ? BOYS : GIRLS;
  let name = first;
  while (!name || taken.has(name)) name = pick(pool);
  const kid = { first: name, last: fam.surname, gender, grade, family: fam };
  kid.key = `${slug(gradeLabel(grade))}-${slug(name)}-${slug(fam.surname)}`;
  kid.id = sid(`student:${kid.key}`);
  fam.kids.push(kid);
  students.push(kid);
  return kid;
};

// The headline family: Amal and Karim Haddad, with Adam (Grade 5, the
// student login), Lina (Grade 2) and Sara (SK).
const haddad = newFamily('Haddad', { mother: 'Amal', father: 'Karim' });
const adam = addKid(haddad, '5', 'Adam', 'm');
const lina = addKid(haddad, '2', 'Lina', 'f');
const sara = addKid(haddad, 'SK', 'Sara', 'f');

for (const grade of C.GRADES) {
  while (students.filter((s) => s.grade === grade).length < C.CLASS_SIZE[grade]) {
    const gender = rand() < 0.5 ? 'm' : 'f';
    const sibling = rand() < 0.3
      ? families.find((f) => f !== haddad && f.kids.length < 3 && !f.kids.some((k) => k.grade === grade) && rand() < 0.4)
      : null;
    if (sibling) {
      addKid(sibling, grade, null, gender);
    } else {
      const r = rand();
      const fam = newFamily(surnamePool.pop(), { mother: r < 0.03 ? null : undefined, father: r > 0.93 ? null : undefined });
      addKid(fam, grade, null, gender);
    }
  }
}

// Guardians and their accounts.
for (const fam of families) {
  for (const role of ['mother', 'father']) {
    const g = fam[role];
    if (!g) continue;
    g.name = `${g.first} ${fam.surname}`;
    g.relation = role === 'mother' ? 'Mother' : 'Father';
    g.phone = phone();
    g.email = fam === haddad && role === 'mother'
      ? `parent@${C.DOMAIN}`
      : uniqueEmail(`${slug(g.first)}.${slug(fam.surname)}`, C.DOMAIN);
  }
  const r = rand();
  if (fam === haddad) {
    fam.mother.account = true;
    fam.father.account = true;
  } else if (r < 0.1) {
    fam.inviteSent = r < 0.04; // no accounts yet; some with an invite out
  } else {
    if (fam.mother) fam.mother.account = rand() < 0.8 || !fam.father;
    if (fam.father) fam.father.account = !fam.mother?.account || rand() < 0.3;
  }
  for (const role of ['mother', 'father']) {
    const g = fam[role];
    if (g && g.account) g.id = sid(`user:parent:${g.email}`);
  }
  fam.address = `${100 + Math.floor(rand() * 4800)} ${pick(STREETS)}, ${pick(CITIES)}, ON`;
  fam.subsidy = fam !== haddad && rand() < 0.08;
}

// Abilities drive every generated score; Adam is a strong, uneven student.
const ability = new Map();
for (const s of students) ability.set(s.id, Math.round(56 + 40 * ((rand() + rand() + rand()) / 3)));
ability.set(adam.id, 84);
ability.set(lina.id, 90);

// Student logins (Grades 5–8) and student emails (Grade 4 and up).
const loginPlan = { 5: [12, 0], 6: [8, 2], 7: [7, 2], 8: [6, 2] }; // [active, invited]
for (const grade of Object.keys(loginPlan)) {
  const inGrade = students.filter((s) => s.grade === grade);
  const ordered = [adam, ...inGrade.filter((s) => s !== adam)].filter((s) => s.grade === grade);
  ordered.forEach((s, i) => {
    const [active, invited] = loginPlan[grade];
    if (i < active) s.login = 'active';
    else if (i < active + invited) s.login = 'invited';
  });
}
for (const s of students) {
  if (['JK', 'SK', '1', '2', '3'].includes(s.grade)) continue;
  s.email = s === adam ? `student@${C.DOMAIN}` : uniqueEmail(`${slug(s.first)}.${slug(s.last)}`, C.STUDENT_DOMAIN);
  if (s.login) s.userId = sid(`user:student:${s.key}`);
}
const requests = [...['7', '8']].map((g) => students.filter((s) => s.grade === g && !s.login).pop());
const homeroomOf = (grade) => staff.find((s) => s.homeroom === grade);
const avatarFor = (s) => {
  const older = !['JK', 'SK', '1', '2', '3'].includes(s.grade);
  const style = s.gender === 'm'
    ? pick(['short', 'short', 'curly', 'kufi'])
    : pick(older ? ['hijab', 'hijab', 'long', 'curly'] : ['long', 'long', 'curly']);
  return { style, skin: Math.floor(rand() * 5), bg: Math.floor(rand() * 8) };
};
for (const s of students) s.avatar = avatarFor(s);
const birthYear = (grade) => 2021 - (grade === 'JK' ? -1 : grade === 'SK' ? 0 : Number(grade));

// ── classes and the timetable ───────────────────────────────────────────────
const classes = [];
for (const grade of C.GRADES) {
  for (const subject of C.subjectsFor(grade)) {
    const lead = staffBy[C.leadFor(grade, subject)];
    classes.push({
      id: sid(`class:${grade}:${subject}`), grade, subject, family: C.FAMILY_OF_SUBJECT[subject] || null, teacher: lead,
      showAverage: C.SHOW_AVERAGE.some(([g, sub]) => g === grade && sub === subject),
    });
  }
}
const classOf = (grade, subject) => classes.find((c) => c.grade === grade && c.subject === subject);
const timetable = buildTimetable();

// ── SQL building blocks ─────────────────────────────────────────────────────
const PRELUDE = `
CREATE OR REPLACE FUNCTION pg_temp.rnd(k text) RETURNS float8 LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('x' || substr(md5(k), 1, 12))::bit(48)::bigint / 281474976710656.0 $$;
CREATE OR REPLACE FUNCTION pg_temp.at(d date, t time) RETURNS timestamptz LANGUAGE sql STABLE AS
  $$ SELECT (d + t) AT TIME ZONE 'America/Toronto' $$;
CREATE OR REPLACE FUNCTION pg_temp.sid(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT md5('playground-seed:' || k)::uuid $$;
`;
const CTX = `
-- The year, its active term, today (Toronto) and the school days so far.
CREATE TEMP TABLE ctx ON COMMIT DROP AS
SELECT y.school_year_id AS year_id, y.school_id, (now() AT TIME ZONE 'America/Toronto')::date AS today,
       t.term_id, t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end,
       t.start_date - (EXTRACT(ISODOW FROM t.start_date)::int - 1) AS term_monday
  FROM school_years y
  JOIN terms t ON t.school_year_id = y.school_year_id AND t.is_active
 WHERE y.school = 'PLAYGROUND' AND y.label = ${lit(C.YEAR_LABEL)};
DO $$ BEGIN IF (SELECT count(*) FROM ctx) <> 1 THEN RAISE EXCEPTION 'PLAYGROUND ${C.YEAR_LABEL} with one active term not found: run 01 first'; END IF; END $$;
CREATE TEMP TABLE school_days ON COMMIT DROP AS
SELECT d::date AS day
  FROM ctx, generate_series(ctx.term_start, ctx.term_end, interval '1 day') d
 WHERE EXTRACT(ISODOW FROM d) < 6
   AND NOT EXISTS (SELECT 1 FROM school_calendar_events e
                    WHERE e.school = 'PLAYGROUND' AND e.school_year_id = ctx.year_id AND e.is_school_closed
                      AND d::date BETWEEN e.start_date AND COALESCE(e.end_date, e.start_date));
`;
const CLS = `
CREATE TEMP TABLE cls ON COMMIT DROP AS
SELECT v.class_id::uuid, v.grade, v.subject, v.family, v.teacher_id::uuid, v.show_avg FROM (VALUES
${values(classes.map((c) => [lit(c.id), lit(c.grade), lit(c.subject), lit(c.family), lit(c.teacher.id), lit(c.showAverage)]))}
) v(class_id, grade, subject, family, teacher_id, show_avg);
`;
const tplRows = [];
const unitRows = [];
for (const [family, g] of Object.entries(C.GRADEBOOK)) {
  g.units.forEach((u, i) => unitRows.push([lit(family), i + 1, lit(u)]));
  const counts = {};
  g.items.forEach(([cat]) => { counts[cat] = (counts[cat] || 0) + 1; });
  const sortInCat = {};
  g.items.forEach(([cat, name, max, week, kind]) => {
    sortInCat[cat] = (sortInCat[cat] || 0) + 1;
    const catIdx = g.categories.findIndex(([n]) => n === cat);
    const weight = g.categories[catIdx][1];
    const unit = week <= 7 ? 1 : week <= 13 ? 2 : 3;
    tplRows.push([lit(family), lit(cat), weight, catIdx + 1, counts[cat], lit(name), max, week, sortInCat[cat], lit(kind), unit, g.day]);
  });
}
const TPL = `
CREATE TEMP TABLE tpl ON COMMIT DROP AS
SELECT * FROM (VALUES
${values(tplRows)}
) v(family, category, cat_weight, cat_sort, n_in_cat, name, max_score, week, item_sort, kind, unit, dow);
CREATE TEMP TABLE tpl_units ON COMMIT DROP AS
SELECT * FROM (VALUES
${values(unitRows)}
) v(family, ord, name);
`;
const ABILITY = `
CREATE TEMP TABLE ability ON COMMIT DROP AS
SELECT v.student_id::uuid, v.ability FROM (VALUES
${values(students.map((s) => [lit(s.id), ability.get(s.id)]))}
) v(student_id, ability);
`;
const LOGINS = `
CREATE TEMP TABLE logins ON COMMIT DROP AS
SELECT sal.student_id, sal.user_id
  FROM student_account_links sal
  JOIN users u ON u.user_id = sal.user_id
  JOIN ctx ON sal.school_year_id = ctx.year_id
 WHERE u.password <> '!';
`;
const file = (name, header, body, { ctx = true } = {}) => {
  const sql = `-- ${name} — generated by scripts/seed/playground/generate.js; edit that, not this.
-- ${header}
BEGIN;
${PRELUDE}${ctx ? CTX : ''}${body}
COMMIT;
`;
  fs.writeFileSync(path.join(OUT, name), sql);
  return sql.length;
};

// Seeded accounts, and PLAYGROUND accounts someone deleted (Delete Account
// erases rather than removes, moving the address to deleted.schoolmule.invalid):
// a reseed must clear those too, or the reviewer's fixed id collides.
const SEED_USERS = `SELECT user_id FROM users WHERE school = 'PLAYGROUND'
  AND (email LIKE '%@${C.DOMAIN}' OR email LIKE '%.${C.DOMAIN}' OR email LIKE 'deleted-%@deleted.schoolmule.invalid')`;

// ── 00 reset ────────────────────────────────────────────────────────────────
const reset = `
-- Everything in PLAYGROUND ${C.YEAR_LABEL} belongs to the seed, as do the
-- accounts on @${C.DOMAIN}. Other years and other accounts are never touched.
CREATE TEMP TABLE y ON COMMIT DROP AS
SELECT school_year_id FROM school_years WHERE school = 'PLAYGROUND' AND label = ${lit(C.YEAR_LABEL)};
CREATE TEMP TABLE su ON COMMIT DROP AS ${SEED_USERS};
CREATE TEMP TABLE ys ON COMMIT DROP AS SELECT student_id FROM students WHERE school_year_id IN (SELECT * FROM y);

DELETE FROM conversations WHERE school = 'PLAYGROUND' AND (student_id IN (SELECT * FROM ys) OR created_by IN (SELECT * FROM su));
DELETE FROM announcements WHERE school = 'PLAYGROUND' AND (school_year_id IN (SELECT * FROM y) OR author_id IN (SELECT * FROM su));
DELETE FROM planner_schedules WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_period_rules WHERE school_year_id IN (SELECT * FROM y)
   OR teacher_id IN (SELECT planner_teacher_id FROM planner_teachers WHERE school_year_id IN (SELECT * FROM y));
DELETE FROM planner_courses WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_class_groups WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_fixed_blocks WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_day_templates WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_rooms WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_teachers WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM planner_settings WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM school_calendar_events WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM classes WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM families WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM student_view_emails WHERE student_id IN (SELECT * FROM ys) OR sent_by IN (SELECT * FROM su);
DELETE FROM student_account_requests WHERE school = 'PLAYGROUND' AND (email LIKE '%.${C.DOMAIN}' OR email LIKE '%@${C.DOMAIN}');
DELETE FROM students WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM terms WHERE school_year_id IN (SELECT * FROM y);
DELETE FROM registration_forms WHERE school = 'PLAYGROUND' AND created_by IN (SELECT * FROM su);
DELETE FROM staff WHERE school = 'PLAYGROUND' AND email LIKE '%@${C.DOMAIN}';

-- What seed accounts may have left elsewhere while testing.
DELETE FROM assessment_publication_batches WHERE triggered_by IN (SELECT * FROM su);
DELETE FROM assessment_publication_emails WHERE sent_by IN (SELECT * FROM su);
UPDATE assessments SET published_by = NULL WHERE published_by IN (SELECT * FROM su);
UPDATE messages SET deleted_by = NULL WHERE deleted_by IN (SELECT * FROM su);
UPDATE announcements SET deleted_by = NULL WHERE deleted_by IN (SELECT * FROM su);
UPDATE conversations SET resolved_by = NULL WHERE resolved_by IN (SELECT * FROM su);
UPDATE jk_skill_assessments SET assessed_by = NULL WHERE assessed_by IN (SELECT * FROM su);
UPDATE sk_standard_assessments SET assessed_by = NULL WHERE assessed_by IN (SELECT * FROM su);
DELETE FROM patch_notes WHERE created_by IN (SELECT * FROM su);
UPDATE users SET staff_role_id = NULL WHERE user_id IN (SELECT * FROM su);
DELETE FROM users WHERE user_id IN (SELECT * FROM su);

-- School-level rows (classroom settings, pay schedule, the Office Staff role,
-- the JK/SK frameworks) are upserted by the seed, never deleted here: the
-- frameworks cascade into ratings of every year's students.
`;

// ── 01 foundation ───────────────────────────────────────────────────────────
const T1 = sid('term:1');
const T2 = sid('term:2');
const termRows = C.TERMS.map((t) => [lit(sid(`term:${t.no}`)), lit(t.name), `DATE ${lit(t.start)}`, `DATE ${lit(t.end)}`, t.no]);
const ADMIN = staffBy.admin.id;
const officePermissions = ['report_cards', 'students', 'users', 'attendance.daily', 'attendance.classes', 'staff_attendance', 'messages.all', 'announcements.school', 'forms', 'scheduling', 'school_setup'];

const userRows = [];
for (const s of staff) {
  userRows.push([lit(s.id), lit(s.email), lit(s.name), lit(s.first), lit(s.last), lit(s.role), 'TRUE',
    lit(s.title || null), s.officeRole ? lit(sid('role:office')) : 'NULL', json({ style: s.avatar[0], skin: s.avatar[1], bg: s.avatar[2] }),
    "pg_temp.at(DATE '2026-08-24', '10:00')", `now() - interval '${1 + Math.floor(rand() * 40)} hours'`, 'FALSE']);
}
for (const fam of families) {
  for (const role of ['mother', 'father']) {
    const g = fam[role];
    if (!g || !g.account) continue;
    const seen = fam === haddad ? `now() - interval '${role === 'mother' ? 3 : 30} hours'` : rand() < 0.75 ? `now() - interval '${2 + Math.floor(rand() * 300)} hours'` : 'NULL';
    userRows.push([lit(g.id), lit(g.email), lit(g.name), lit(g.first), lit(fam.surname), lit('PARENT'), 'TRUE', 'NULL', 'NULL', 'NULL',
      `pg_temp.at(DATE '2026-09-${String(2 + Math.floor(rand() * 20)).padStart(2, '0')}', '19:30')`, seen, 'FALSE']);
  }
}
for (const s of students.filter((x) => x.login)) {
  userRows.push([lit(s.userId), lit(s.email), lit(`${s.first} ${s.last}`), lit(s.first), lit(s.last), lit('STUDENT'), 'TRUE', 'NULL', 'NULL',
    json(s.avatar), "pg_temp.at(DATE '2026-09-15', '09:00')", s.login === 'active' ? `now() - interval '${1 + Math.floor(rand() * 72)} hours'` : 'NULL',
    s.login === 'invited' ? 'TRUE' : 'FALSE']);
}
// The store reviewers' deletable account (foundation, after the guardians).
const REVIEWER = sid('user:reviewer');
const pendingRows = C.PENDING_SIGNUPS.map((p) => [lit(sid(`user:${p.key}`)), lit(`${slug(p.first)}.${slug(p.last)}@${C.DOMAIN}`), lit(`${p.first} ${p.last}`), lit(p.first), lit(p.last), lit(p.role), p.daysAgo]);

const staffDirRows = staff.map((s) => {
  const role = s.title || (s.homeroom ? `${gradeLabel(s.homeroom)} Teacher` : `${s.subject || 'Arabic & Islamic Studies'} Teacher`);
  const teaching = classes.filter((c) => c.teacher === s).map((c) => `${gradeLabel(c.grade)} ${c.subject}`);
  return [lit(sid(`staff:${s.key}`)), lit(s.name), lit(role), json(teaching), lit(s.homeroom || null), lit(s.email), lit(phone()),
    lit(s.key === 'admin' || s.key === 'office' ? 'phone' : 'email'), lit('8:00–8:30 am'), lit('Replies within one school day')];
});

const studentRows = students.map((s) => {
  const fam = s.family;
  const ht = homeroomOf(s.grade);
  const dob = `${birthYear(s.grade)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`;
  const oen = `${100 + Math.floor(rand() * 900)}-${100 + Math.floor(rand() * 900)}-${100 + Math.floor(rand() * 900)}`;
  const emergency = `${pick(['Aunt', 'Uncle', 'Grandmother', 'Grandfather'])} ${pick([...MOTHERS, ...FATHERS])} ${fam.surname} — ${phone()}`;
  return [lit(s.id), lit(`${s.first} ${s.last}`), lit(ht.id), `${lit(s.grade)}::"GRADE"`, lit(oen),
    lit(fam.mother?.name ?? null), lit(fam.mother?.email ?? null), lit(fam.mother?.phone ?? null),
    lit(fam.father?.name ?? null), lit(fam.father?.email ?? null), lit(fam.father?.phone ?? null),
    lit(emergency), `DATE ${lit(dob)}`, lit(rand() < 0.08 ? pick(MEDICAL) : null), lit(fam.address), lit(s.email || null), json(s.avatar)];
});

const guardianRows = [];
for (const s of students) {
  for (const role of ['mother', 'father']) {
    const g = s.family[role];
    if (!g) continue;
    const lastSeen = s.family === haddad && role === 'mother' ? "now() - interval '4 days'" : 'NULL';
    const invited = s.family.inviteSent ? "now() - interval '6 days'" : 'NULL';
    guardianRows.push([lit(sid(`ps:${s.key}:${role}`)), lit(s.id), g.account ? lit(g.id) : 'NULL', lit(g.name), lit(g.email), lit(g.phone), lit(g.relation),
      lastSeen, invited, s.family.inviteSent ? lit(ADMIN) : 'NULL']);
  }
}

const loginRows = students.filter((s) => s.login).map((s) => [lit(s.userId), lit(s.id), lit(s.login), lit(s.email)]);
const requestRows = requests.map((s) => [lit(sid(`request:${s.key}`)), lit(s.first), lit(s.last), lit(s.grade), lit(s.email)]);

const calendarRows = C.CALENDAR.map(([start, end, title, cat, closed, staffDay, notes]) => [lit(sid(`event:${start}:${title}`)), lit(title), lit(cat), `DATE ${lit(start)}`, end ? `DATE ${lit(end)}` : 'NULL', lit(closed), lit(notes), lit(staffDay)]);

const foundation = `
-- ── Year and terms ──────────────────────────────────────────────────────────
-- 2026-2027 becomes the active year. 2025-2026 keeps all of its data; only
-- its dates are set to a normal school year so the two no longer overlap.
UPDATE school_years SET is_active = FALSE, start_date = DATE '2025-09-01', end_date = DATE '2026-06-30', updated_at = now()
 WHERE school = 'PLAYGROUND' AND label = '2025-2026';
UPDATE school_years SET is_active = TRUE, start_date = DATE '2026-09-01', end_date = DATE '2027-06-30', updated_at = now()
 WHERE school = 'PLAYGROUND' AND label = ${lit(C.YEAR_LABEL)};
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM school_years WHERE school = 'PLAYGROUND' AND label = ${lit(C.YEAR_LABEL)} AND is_active) THEN
  RAISE EXCEPTION 'PLAYGROUND has no ${C.YEAR_LABEL} year: create it from School settings first'; END IF; END $$;

INSERT INTO terms (term_id, school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id)
SELECT v.term_id::uuid, 'PLAYGROUND', y.school_id, v.name, v.start_date, v.end_date, y.label,
       CASE WHEN (now() AT TIME ZONE 'America/Toronto')::date >= DATE '2027-02-01' THEN v.no = 2 ELSE v.no = 1 END, y.school_year_id
  FROM (VALUES
${values(termRows)}
  ) v(term_id, name, start_date, end_date, no)
  CROSS JOIN school_years y WHERE y.school = 'PLAYGROUND' AND y.label = ${lit(C.YEAR_LABEL)};

INSERT INTO school_calendar_events (event_id, school, school_id, title, category, start_date, end_date, is_school_closed, notes, school_year_id, staff_day)
SELECT v.event_id::uuid, 'PLAYGROUND', y.school_id, v.title, v.category, v.start_date, v.end_date, v.closed, v.notes, y.school_year_id, v.staff_day
  FROM (VALUES
${values(calendarRows)}
  ) v(event_id, title, category, start_date, end_date, closed, notes, staff_day)
  CROSS JOIN school_years y WHERE y.school = 'PLAYGROUND' AND y.label = ${lit(C.YEAR_LABEL)};
${CTX}
-- ── School settings ─────────────────────────────────────────────────────────
INSERT INTO school_classroom_settings (school, enabled, login_from_grade, qr_until_grade, student_email_from_grade,
       parents_read_private_comments, summary_dow, student_photos, consent_notice_version, student_email_domains,
       student_sign_in, parent_summary, updated_at)
VALUES ('PLAYGROUND', TRUE, '4', '3', '4', TRUE, 5, FALSE, '2026-10', ARRAY[${lit(C.STUDENT_DOMAIN)}], 'google_or_password', TRUE, now())
ON CONFLICT (school) DO UPDATE SET enabled = EXCLUDED.enabled, login_from_grade = EXCLUDED.login_from_grade,
       qr_until_grade = EXCLUDED.qr_until_grade, student_email_from_grade = EXCLUDED.student_email_from_grade,
       parents_read_private_comments = EXCLUDED.parents_read_private_comments, summary_dow = EXCLUDED.summary_dow,
       student_photos = EXCLUDED.student_photos, consent_notice_version = EXCLUDED.consent_notice_version,
       student_email_domains = EXCLUDED.student_email_domains, student_sign_in = EXCLUDED.student_sign_in,
       parent_summary = EXCLUDED.parent_summary, updated_at = now();

INSERT INTO staff_pay_schedules (school, frequency, pay_day_of_month, default_hours_per_day, work_day_start)
VALUES ('PLAYGROUND', 'MONTHLY', 25, 7.5, TIME '08:15')
ON CONFLICT (school) DO UPDATE SET frequency = EXCLUDED.frequency, pay_day_of_month = EXCLUDED.pay_day_of_month,
       second_pay_day_of_month = NULL, anchor_pay_date = NULL, default_hours_per_day = EXCLUDED.default_hours_per_day,
       work_day_start = EXCLUDED.work_day_start, updated_at = now();

INSERT INTO staff_roles (role_id, school, name, description, permissions)
VALUES (${lit(sid('role:office'))}, 'PLAYGROUND', 'Office Staff', 'Front office: people, attendance, messages, forms and school setup — no grades or finance.', ${arr(officePermissions)})
ON CONFLICT (role_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, permissions = EXCLUDED.permissions;

-- ── Accounts (password ${C.PASSWORD} for every seeded login) ────────────────
CREATE TEMP TABLE pw ON COMMIT DROP AS SELECT crypt(${lit(C.PASSWORD)}, gen_salt('bf', 10)) AS hash;
INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school,
                   is_archived, staff_title, staff_role_id, avatar, created_at, last_login_at, last_seen_at)
SELECT v.user_id::uuid, v.email, v.username, CASE WHEN v.invited THEN '!' ELSE pw.hash END, v.first_name, v.last_name, 'PLAYGROUND',
       v.role::role, TRUE, v.verified, FALSE, v.title, v.staff_role_id::uuid, v.avatar::jsonb, v.created_at::timestamptz, v.seen::timestamptz, v.seen::timestamptz
  FROM (VALUES
${values(userRows)}
  ) v(user_id, email, username, first_name, last_name, role, verified, title, staff_role_id, avatar, created_at, seen, invited)
  CROSS JOIN pw;

-- Signed up, waiting in Approvals.
INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, created_at)
SELECT v.user_id::uuid, v.email, v.username, pw.hash, v.first_name, v.last_name, 'PLAYGROUND', v.role::role, TRUE, FALSE,
       now() - make_interval(days => v.days_ago)
  FROM (VALUES
${values(pendingRows)}
  ) v(user_id, email, username, first_name, last_name, role, days_ago)
  CROSS JOIN pw;

INSERT INTO staff (staff_id, school, full_name, staff_role, teaching_assignments, homeroom_grade, email, phone,
                   preferred_contact, phone_contact_hours, email_contact_hours)
SELECT v.staff_id::uuid, 'PLAYGROUND', v.full_name, v.staff_role, v.teaching, v.homeroom, v.email, v.phone, v.pref, v.phone_hours, v.email_hours
  FROM (VALUES
${values(staffDirRows)}
  ) v(staff_id, full_name, staff_role, teaching, homeroom, email, phone, pref, phone_hours, email_hours);

INSERT INTO staff_work_schedules (user_id, school, work_days, hours_per_day, updated_by)
VALUES ${staff.filter((s) => s.workDays || s.hoursPerDay).map((s) => `(${lit(s.id)}, 'PLAYGROUND', ${s.workDays ? arr(s.workDays.map(String), 'smallint') : 'NULL'}, ${s.hoursPerDay || 'NULL'}, ${lit(ADMIN)})`).join(',\n       ')};

-- ── Students and guardians ──────────────────────────────────────────────────
INSERT INTO students (student_id, name, homeroom_teacher_id, grade, oen, mother_name, mother_email, mother_number,
                      father_name, father_email, father_number, emergency_contact, date_of_birth, medical_notes, address,
                      student_email, avatar, school, school_year_id, created_at, last_modified_at)
SELECT v.student_id::uuid, v.name, v.homeroom::uuid, v.grade, v.oen, v.mother_name, v.mother_email, v.mother_number,
       v.father_name, v.father_email, v.father_number, v.emergency, v.dob, v.medical::text, v.address, v.student_email, v.avatar::jsonb,
       'PLAYGROUND', ctx.year_id, TIMESTAMP '2026-08-20 10:00', TIMESTAMP '2026-08-20 10:00'
  FROM (VALUES
${values(studentRows)}
  ) v(student_id, name, homeroom, grade, oen, mother_name, mother_email, mother_number, father_name, father_email,
      father_number, emergency, dob, medical, address, student_email, avatar)
  CROSS JOIN ctx;

INSERT INTO parent_students (parent_student_link_id, student_id, parent_id, parent_name, parent_email, parent_number, relation,
                             school, last_seen_at, invited_at, invited_by, created_at)
SELECT v.link_id::uuid, v.student_id::uuid, v.parent_id::uuid, v.name, v.email, v.phone, v.relation, 'PLAYGROUND',
       v.last_seen::timestamptz, v.invited_at::timestamptz, v.invited_by::uuid, TIMESTAMPTZ '2026-08-25 12:00-04'
  FROM (VALUES
${values(guardianRows)}
  ) v(link_id, student_id, parent_id, name, email, phone, relation, last_seen, invited_at, invited_by);

-- An account for App Store and Google Play reviewers to delete from Settings
-- (Delete Account): a guardian of Lina, so the parent portal has a child.
-- A reseed brings it back.
INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, created_at)
SELECT ${lit(REVIEWER)}::uuid, ${lit(`reviewer@${C.DOMAIN}`)}, 'Riley Reviewer', pw.hash, 'Riley', 'Reviewer', 'PLAYGROUND', 'PARENT', TRUE, TRUE,
       now() - interval '3 days'
  FROM pw;
INSERT INTO parent_students (parent_student_link_id, student_id, parent_id, parent_name, parent_email, relation, school, created_at)
VALUES (${lit(sid('link:reviewer'))}::uuid, ${lit(lina.id)}::uuid, ${lit(REVIEWER)}::uuid, 'Riley Reviewer', ${lit(`reviewer@${C.DOMAIN}`)},
        'Guardian', 'PLAYGROUND', now() - interval '3 days');

-- ── Student logins: Grade 5 all active; Grades 6–8 mostly active, some invited ─
CREATE TEMP TABLE seed_logins ON COMMIT DROP AS
SELECT v.user_id::uuid, v.student_id::uuid, v.state, v.email FROM (VALUES
${values(loginRows)}
) v(user_id, student_id, state, email);

INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by, created_at,
                              activated_at, activated_via)
SELECT l.user_id, 'PLAYGROUND', ${lit(ADMIN)}, pg_temp.at(DATE '2026-09-14', '15:00'), '2026-10', ${lit(ADMIN)},
       pg_temp.at(DATE '2026-09-14', '15:00'),
       CASE WHEN l.state = 'active' THEN pg_temp.at(DATE '2026-09-15', '18:00') + make_interval(hours => (pg_temp.rnd('act:' || l.user_id) * 200)::int) END,
       CASE WHEN l.state = 'active' THEN 'password' END
  FROM seed_logins l;
INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by)
SELECT l.user_id, l.student_id, ctx.year_id, ${lit(ADMIN)} FROM seed_logins l CROSS JOIN ctx;
INSERT INTO student_invites (school, user_id, student_id, school_year_id, email, token_hash, expires_at, created_by, created_at,
                             send_status, sent_at)
SELECT 'PLAYGROUND', l.user_id, l.student_id, ctx.year_id, l.email, md5('playground-invite:' || l.user_id || now()),
       now() + interval '5 days', ${lit(ADMIN)}, now() - interval '2 days', 'sent', now() - interval '2 days'
  FROM seed_logins l CROSS JOIN ctx WHERE l.state = 'invited';

-- Two students asked for an account from the sign-up page.
INSERT INTO student_account_requests (request_id, school, first_name, last_name, grade, email, created_at)
SELECT v.request_id::uuid, 'PLAYGROUND', v.first_name, v.last_name, v.grade, v.email, now() - interval '20 hours'
  FROM (VALUES
${values(requestRows)}
  ) v(request_id, first_name, last_name, grade, email);

-- Amal Haddad gets the weekly summary on Fridays; Karim gets a daily one.
INSERT INTO notification_prefs (user_id, weekly_summary, summary_frequency, summary_dow, missing_alerts)
VALUES (${lit(haddad.mother.id)}, TRUE, 'weekly', 5, TRUE),
       (${lit(haddad.father.id)}, TRUE, 'daily', NULL, FALSE);
`;

// ── 02 classes and gradebook ────────────────────────────────────────────────
const coRows = C.CO_TEACHERS.map((ct) => `(${lit(classOf(ct.grade, ct.subject).id)}, ${lit(staffBy[ct.key].id)})`);
const gradebook = `${CLS}${TPL}${ABILITY}
INSERT INTO classes (class_id, school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id,
                     show_class_average, created_at)
SELECT c.class_id, 'PLAYGROUND', c.grade::"GRADE", c.subject, u.first_name || ' ' || u.last_name, c.teacher_id,
       ctx.term_id, ctx.term_name, ctx.year_id, c.show_avg, pg_temp.at(ctx.term_start - 14, '10:00')
  FROM cls c JOIN users u ON u.user_id = c.teacher_id CROSS JOIN ctx;
INSERT INTO class_teachers (class_id, teacher_id) VALUES ${coRows.join(', ')};
INSERT INTO class_students (class_id, student_id, enrolled_at, created_at)
SELECT c.class_id, s.student_id, pg_temp.at(ctx.term_start - 7, '10:00'), pg_temp.at(ctx.term_start - 7, '10:00')
  FROM cls c CROSS JOIN ctx
  JOIN students s ON s.school_year_id = ctx.year_id AND s.grade::text = c.grade;

INSERT INTO classwork_topics (topic_id, class_id, name, sort_order, created_at)
SELECT pg_temp.sid('topic:' || c.class_id || ':' || u.ord), c.class_id, u.name, u.ord, pg_temp.at(ctx.term_start - 5, '09:00')
  FROM cls c JOIN tpl_units u ON u.family = c.family CROSS JOIN ctx
 WHERE c.grade NOT IN ('JK', 'SK');

-- Categories, then columns. The assessments insert trigger gives every column
-- its plain classwork item; 03 turns some into assignments and quizzes.
INSERT INTO assessments (assessment_id, class_id, name, is_parent, weight_points, sort_order, created_at, last_modified_at)
SELECT DISTINCT pg_temp.sid('cat:' || c.class_id || ':' || t.category), c.class_id, t.category, TRUE, t.cat_weight::numeric,
       t.cat_sort, pg_temp.at(ctx.term_start - 5, '09:00'), pg_temp.at(ctx.term_start - 5, '09:00')
  FROM cls c JOIN tpl t ON t.family = c.family CROSS JOIN ctx
 WHERE c.grade NOT IN ('JK', 'SK');

INSERT INTO assessments (assessment_id, class_id, name, parent_assessment_id, is_parent, weight_points, max_score, sort_order,
                         date, created_at, last_modified_at)
SELECT pg_temp.sid('assessment:' || c.class_id || ':' || t.name), c.class_id, t.name,
       pg_temp.sid('cat:' || c.class_id || ':' || t.category), FALSE, round(t.cat_weight::numeric / t.n_in_cat, 2), t.max_score,
       t.item_sort, d.day, LEAST(pg_temp.at(d.day - 12, '09:00'), now()), LEAST(pg_temp.at(d.day - 12, '09:00'), now())
  FROM cls c JOIN tpl t ON t.family = c.family CROSS JOIN ctx
  CROSS JOIN LATERAL (SELECT min(sd.day) AS day FROM school_days sd
                       WHERE sd.day >= ctx.term_monday + (t.week - 1) * 7 + (t.dow - 1)) d
 WHERE c.grade NOT IN ('JK', 'SK');

-- Scores up to today. Older than four days: published (with ~3% missing and
-- ~2% excused). The last four days: scored but still drafts; today's column
-- is only partly entered.
INSERT INTO student_assessments (student_id, assessment_id, score, status)
SELECT cs.student_id, a.assessment_id,
       CASE WHEN st.status = 'graded' THEN round(LEAST(100, GREATEST(32,
              ab.ability + (pg_temp.rnd('aff:' || cs.student_id || c.subject) - 0.5) * 14
              + (pg_temp.rnd('n:' || cs.student_id || a.assessment_id) - 0.5) * 24
              + CASE WHEN c.family IN ('PE', 'Art') THEN 7 ELSE 0 END)) / 100.0 * a.max_score * 2) / 2 END,
       st.status
  FROM assessments a
  JOIN cls c ON c.class_id = a.class_id
  JOIN class_students cs ON cs.class_id = a.class_id
  JOIN ability ab ON ab.student_id = cs.student_id
  CROSS JOIN ctx
  CROSS JOIN LATERAL (SELECT CASE WHEN a.date > ctx.today - 4 THEN 'graded'
                                  WHEN pg_temp.rnd('st:' || cs.student_id || a.assessment_id) < 0.03 THEN 'missing'
                                  WHEN pg_temp.rnd('st:' || cs.student_id || a.assessment_id) < 0.05 THEN 'excused'
                                  ELSE 'graded' END AS status) st
 WHERE NOT a.is_parent AND a.date <= ctx.today
   AND (a.date < ctx.today OR pg_temp.rnd('today:' || cs.student_id || a.assessment_id) < 0.6);

UPDATE assessments a
   SET is_published = TRUE,
       published_at = LEAST(pg_temp.at(a.date + 2 + (pg_temp.rnd('pub:' || a.assessment_id) * 3)::int, '16:10'), now() - interval '1 hour'),
       published_by = c.teacher_id,
       parent_comment = CASE WHEN a.max_score >= 50 AND pg_temp.rnd('pc:' || a.assessment_id) < 0.4
                             THEN 'Thank you for reviewing this with your child. We will go over the trickiest questions together in class.' END
  FROM cls c, ctx
 WHERE c.class_id = a.class_id AND NOT a.is_parent AND a.date <= ctx.today - 4;

INSERT INTO assessment_publication_batches (batch_id, class_id, school, action, assessment_ids, triggered_by, created_at)
SELECT pg_temp.sid('batch:' || a.class_id || ':' || a.published_at), a.class_id, 'PLAYGROUND', 'publish',
       array_agg(a.assessment_id ORDER BY a.sort_order), min(a.published_by::text)::uuid, a.published_at
  FROM assessments a JOIN cls c ON c.class_id = a.class_id
 WHERE a.is_published
 GROUP BY a.class_id, a.published_at;
UPDATE assessments a SET publication_batch_id = pg_temp.sid('batch:' || a.class_id || ':' || a.published_at)
  FROM cls c WHERE c.class_id = a.class_id AND a.is_published;
-- A category is published with its columns (the gradebook's category Publish),
-- stamped with its latest column: the parent feed and digest read that row.
UPDATE assessments p SET is_published = TRUE, published_at = x.latest, published_by = x.by
  FROM (SELECT parent_assessment_id, max(published_at) AS latest, min(published_by::text)::uuid AS by
          FROM assessments WHERE is_published AND parent_assessment_id IS NOT NULL GROUP BY parent_assessment_id) x
 WHERE p.assessment_id = x.parent_assessment_id AND p.class_id IN (SELECT class_id FROM cls);

-- The trigger-made items: units as topics, posted a few days before the date.
UPDATE classwork_items i
   SET topic_id = pg_temp.sid('topic:' || i.class_id || ':' || t.unit),
       created_by = c.teacher_id,
       created_at = LEAST(pg_temp.at(a.date - 5, '08:05'), now() - interval '3 hours'),
       posted_at = LEAST(pg_temp.at(a.date - 5, '08:05'), now() - interval '3 hours'),
       sort_order = a.sort_order
  FROM assessments a JOIN cls c ON c.class_id = a.class_id JOIN tpl t ON t.family = c.family AND t.name = a.name
 WHERE i.assessment_id = a.assessment_id;
`;

// ── 03 classwork ────────────────────────────────────────────────────────────
const quizRows = [];
for (const [quiz, qs] of Object.entries(C.SCIENCE_QUIZZES)) {
  qs.forEach(([kind, prompt, options, extra], i) => {
    const points = { one: 4, many: 6, short: 4, long: 6 }[kind];
    const opts = options ? options.map((text, j) => ({ id: 'abcdefgh'[j], text })) : [];
    const correct = kind === 'one' || kind === 'many' ? extra : [];
    const accepted = kind === 'short' ? extra : [];
    quizRows.push([lit(quiz), i + 1, lit(kind), lit(prompt), json(opts), json(correct), arr(accepted), points, lit(kind === 'many')]);
  });
}
const longAnswerSql = `(ARRAY[${C.LONG_ANSWERS.map(lit).join(', ')}])`;
const textAnswerSql = `(ARRAY[${C.TEXT_ANSWERS.map(lit).join(', ')}])`;
const feedbackSql = `(ARRAY[${C.FEEDBACK.map(lit).join(', ')}])`;
const materialRows = [];
for (const c of classes) {
  const list = C.MATERIALS[c.family || 'Kindergarten'] || [];
  list.forEach(([title, body, url, linkTitle], i) => materialRows.push([lit(c.id), i + 1, lit(title), lit(body), lit(url), lit(linkTitle)]));
}
const g5 = (subject) => lit(classOf('5', subject).id);
const ADAM = lit(adam.id);
const ADAM_USER = lit(adam.userId);
const classwork = `${CLS}${TPL}${ABILITY}${LOGINS}
CREATE TEMP TABLE quizq ON COMMIT DROP AS
SELECT * FROM (VALUES
${values(quizRows)}
) v(quiz, ord, kind, prompt, options, correct, accepted, points, partial);

-- ── Turn-in work in Grades 5–8 (the grades that sign in) ────────────────────
UPDATE classwork_items i
   SET kind = CASE WHEN t.kind = 'quiz' THEN 'quiz' ELSE 'assignment' END,
       submission_mode = CASE t.kind WHEN 'done' THEN 'done' WHEN 'text' THEN 'text'
                                     WHEN 'lab' THEN CASE WHEN a.date > ctx.today THEN 'file' ELSE 'text' END ELSE 'none' END,
       instructions = CASE t.kind WHEN 'done' THEN ${lit(C.INSTRUCTIONS.done)} WHEN 'text' THEN ${lit(C.INSTRUCTIONS.text)}
                                  WHEN 'lab' THEN ${lit(C.INSTRUCTIONS.lab)} ELSE ${lit(C.INSTRUCTIONS.quiz)} END,
       due_at = pg_temp.at(a.date, '15:30'),
       posted_at = LEAST(pg_temp.at(a.date - 7, '08:00'), now() - interval '2 hours'),
       created_at = LEAST(pg_temp.at(a.date - 7, '07:50'), now() - interval '2 hours'),
       quiz_release = 'after_review',
       quiz_show_answers = (t.kind = 'quiz')
  FROM assessments a JOIN cls c ON c.class_id = a.class_id JOIN tpl t ON t.family = c.family AND t.name = a.name
  CROSS JOIN ctx
 WHERE i.assessment_id = a.assessment_id AND c.grade IN ('5', '6', '7', '8') AND t.kind <> 'plain';

INSERT INTO quiz_questions (question_id, item_id, kind, prompt, options, correct, accepted, points, partial_credit, sort_order)
SELECT pg_temp.sid('q:' || a.assessment_id || ':' || q.ord), i.item_id, q.kind, q.prompt, q.options, q.correct, q.accepted, q.points, q.partial, q.ord
  FROM classwork_items i JOIN assessments a ON a.assessment_id = i.assessment_id JOIN quizq q ON q.quiz = a.name
 WHERE i.kind = 'quiz' AND i.class_id IN (SELECT class_id FROM cls);

-- ── Materials with links, in every class ────────────────────────────────────
CREATE TEMP TABLE mat ON COMMIT DROP AS
SELECT v.class_id::uuid, v.ord, v.title, v.body, v.url, v.link_title FROM (VALUES
${values(materialRows)}
) v(class_id, ord, title, body, url, link_title);
INSERT INTO classwork_items (item_id, class_id, topic_id, kind, title, instructions, submission_mode, status, posted_at,
                             sort_order, created_by, created_at)
SELECT pg_temp.sid('material:' || m.class_id || ':' || m.ord), m.class_id,
       CASE WHEN c.grade NOT IN ('JK', 'SK') THEN pg_temp.sid('topic:' || m.class_id || ':1') END,
       'material', m.title, m.body, 'none', 'posted',
       LEAST(pg_temp.at(ctx.term_start + 2 + m.ord * 11, '08:20'), now() - interval '1 day'), 50 + m.ord, c.teacher_id,
       LEAST(pg_temp.at(ctx.term_start + 2 + m.ord * 11, '08:20'), now() - interval '1 day')
  FROM mat m JOIN cls c ON c.class_id = m.class_id CROSS JOIN ctx;
INSERT INTO classwork_attachments (item_id, kind, url, title, sort_order, created_by)
SELECT pg_temp.sid('material:' || m.class_id || ':' || m.ord), 'link', m.url, m.link_title, 0, c.teacher_id
  FROM mat m JOIN cls c ON c.class_id = m.class_id;

-- Layla Saleh's Grade 5: an ungraded "Mark as done", a draft and a scheduled post.
INSERT INTO classwork_items (item_id, class_id, kind, title, instructions, due_at, submission_mode, status, publish_at, posted_at,
                             sort_order, created_by, created_at)
VALUES
  (pg_temp.sid('extra:g5-form'), ${g5('Math')}, 'assignment', 'Signed field trip form',
   'Bring back the signed permission form for our class trip, then press Mark as done.',
   pg_temp.at((SELECT today FROM ctx) + 2, '08:30'), 'done', 'posted', NULL, now() - interval '7 days', 90,
   ${lit(staffBy.g5.id)}, now() - interval '7 days'),
  (pg_temp.sid('extra:g5-review'), ${g5('Science')}, 'material', 'Unit 2 review sheet',
   'Answers to the review questions — share before the Unit 2 test.', NULL, 'none', 'draft', NULL, NULL, 91,
   ${lit(staffBy.g5.id)}, now() - interval '1 day'),
  (pg_temp.sid('extra:g5-video'), ${g5('Science')}, 'material', 'Ecosystems video',
   'Watch this short video before our ecosystems unit.', NULL, 'none', 'scheduled', pg_temp.at((SELECT today FROM ctx) + 1, '08:00'),
   NULL, 92, ${lit(staffBy.g5.id)}, now() - interval '3 hours');
INSERT INTO classwork_attachments (item_id, kind, url, title, sort_order, created_by)
VALUES (pg_temp.sid('extra:g5-video'), 'link', 'https://kids.nationalgeographic.com/', 'National Geographic Kids', 0, ${lit(staffBy.g5.id)});

-- ── Submissions from the students who sign in ───────────────────────────────
CREATE TEMP TABLE work ON COMMIT DROP AS
SELECT i.item_id, i.submission_mode, i.due_at, a.assessment_id, a.date, a.is_published, a.published_at, c.teacher_id,
       l.student_id, l.user_id,
       pg_temp.rnd('sub:' || a.assessment_id || l.student_id) AS r, pg_temp.rnd('sub2:' || a.assessment_id || l.student_id) AS r2
  FROM classwork_items i
  JOIN assessments a ON a.assessment_id = i.assessment_id
  JOIN cls c ON c.class_id = i.class_id
  JOIN class_students cs ON cs.class_id = i.class_id
  JOIN logins l ON l.student_id = cs.student_id
 WHERE i.kind = 'assignment' AND i.submission_mode <> 'none';

-- Published work: ~10% never turned in (marked missing), ~15% late, the rest
-- on time, every one graded and published, about half with feedback.
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   draft_score, draft_status, feedback, feedback_saved_at, graded_by, published_at, published_by,
                                   created_at, updated_at)
SELECT w.item_id, w.student_id, t.turned - interval '50 minutes', t.turned, t.turned, t.turned > w.due_at,
       CASE WHEN w.submission_mode = 'text' THEN ${textAnswerSql}[1 + (w.r2 * ${C.TEXT_ANSWERS.length})::int % ${C.TEXT_ANSWERS.length}] END,
       CASE WHEN w.submission_mode = 'text' THEN t.turned - interval '5 minutes' END,
       sa.score, sa.status,
       CASE WHEN w.r2 < 0.55 THEN ${feedbackSql}[1 + (w.r * 70)::int % ${C.FEEDBACK.length}] END,
       CASE WHEN w.r2 < 0.55 THEN w.published_at - interval '40 minutes' END,
       w.teacher_id, w.published_at, w.teacher_id, t.turned - interval '50 minutes', w.published_at
  FROM work w
  JOIN student_assessments sa ON sa.student_id = w.student_id AND sa.assessment_id = w.assessment_id
  CROSS JOIN LATERAL (SELECT CASE WHEN w.r > 0.85 THEN w.due_at + make_interval(hours => 2 + (w.r2 * 30)::int)
                                  ELSE w.due_at - make_interval(hours => 1 + (w.r2 * 40)::int) END AS turned) t
 WHERE w.is_published AND w.r >= 0.10 AND sa.status <> 'missing';
UPDATE student_assessments sa SET status = 'missing', score = NULL
  FROM work w
 WHERE sa.student_id = w.student_id AND sa.assessment_id = w.assessment_id AND w.is_published AND w.r < 0.10;

-- Past due but not published yet: most turned in; half already have a draft
-- score (Publish waits for the teacher), the rest wait in To review.
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   draft_score, draft_status, graded_by, created_at, updated_at)
SELECT w.item_id, w.student_id, t.turned - interval '1 hour', t.turned, t.turned, FALSE,
       CASE WHEN w.submission_mode = 'text' THEN ${textAnswerSql}[1 + (w.r2 * ${C.TEXT_ANSWERS.length})::int % ${C.TEXT_ANSWERS.length}] END,
       CASE WHEN w.submission_mode = 'text' THEN t.turned - interval '5 minutes' END,
       CASE WHEN w.r2 < 0.5 THEN sa.score END, CASE WHEN w.r2 < 0.5 AND sa.score IS NOT NULL THEN 'graded' END,
       CASE WHEN w.r2 < 0.5 AND sa.score IS NOT NULL THEN w.teacher_id END, t.turned - interval '1 hour', t.turned
  FROM work w
  CROSS JOIN ctx
  LEFT JOIN student_assessments sa ON sa.student_id = w.student_id AND sa.assessment_id = w.assessment_id
  CROSS JOIN LATERAL (SELECT LEAST(w.due_at - make_interval(hours => 1 + (w.r2 * 20)::int), now() - interval '30 minutes') AS turned) t
 WHERE NOT w.is_published AND w.date <= ctx.today AND w.r >= 0.15;

-- Upcoming work: a few turned in early, a few typed drafts saved.
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   created_at, updated_at)
SELECT w.item_id, w.student_id, now() - interval '1 day',
       CASE WHEN w.r < 0.12 THEN now() - make_interval(hours => 1 + (w.r2 * 20)::int) END,
       CASE WHEN w.r < 0.12 THEN now() - make_interval(hours => 1 + (w.r2 * 20)::int) END, FALSE,
       CASE WHEN w.submission_mode = 'text' THEN ${textAnswerSql}[1 + (w.r2 * ${C.TEXT_ANSWERS.length})::int % ${C.TEXT_ANSWERS.length}] END,
       CASE WHEN w.submission_mode = 'text' THEN now() - make_interval(hours => 2 + (w.r2 * 20)::int) END,
       now() - interval '1 day', now() - interval '1 hour'
  FROM work w CROSS JOIN ctx
 WHERE w.date > ctx.today AND w.submission_mode IN ('done', 'text') AND (w.r < 0.12 OR (w.r < 0.24 AND w.submission_mode = 'text'));

-- ── Quizzes: attempts from students who sign in on the published ones ───────
CREATE TEMP TABLE qwork ON COMMIT DROP AS
SELECT i.item_id, a.assessment_id, a.name AS quiz, a.date, a.published_at, i.due_at, c.teacher_id, l.student_id, ab.ability,
       pg_temp.sid('attempt:' || a.assessment_id || ':' || l.student_id) AS attempt_id,
       i.due_at - make_interval(hours => 2 + (pg_temp.rnd('qt:' || a.assessment_id || l.student_id) * 40)::int) AS submitted
  FROM classwork_items i
  JOIN assessments a ON a.assessment_id = i.assessment_id
  JOIN cls c ON c.class_id = i.class_id
  JOIN class_students cs ON cs.class_id = i.class_id
  JOIN logins l ON l.student_id = cs.student_id
  JOIN ability ab ON ab.student_id = l.student_id
 WHERE i.kind = 'quiz' AND a.is_published AND pg_temp.rnd('qmiss:' || a.assessment_id || l.student_id) >= 0.08;
INSERT INTO quiz_attempts (attempt_id, item_id, student_id, question_order, started_at, submitted_at)
SELECT attempt_id, item_id, student_id, '{}', submitted - interval '22 minutes', submitted FROM qwork;
INSERT INTO quiz_answers (attempt_id, question_id, answer, auto_points, teacher_points, teacher_note, saved_at, graded_by, graded_at)
SELECT q.attempt_id, qq.question_id,
       CASE qq.kind
         WHEN 'one' THEN jsonb_build_object('choice', CASE WHEN ok.v THEN qq.correct->>0 WHEN qq.correct->>0 = 'a' THEN 'b' ELSE 'a' END)
         WHEN 'many' THEN jsonb_build_object('choices', CASE WHEN ok.v THEN qq.correct ELSE jsonb_build_array(qq.correct->>0) END)
         WHEN 'short' THEN jsonb_build_object('text', CASE WHEN ok.v THEN qq.accepted[1] ELSE 'not sure' END)
         ELSE jsonb_build_object('text', ${longAnswerSql}[1 + (pg_temp.rnd('la:' || q.attempt_id) * ${C.LONG_ANSWERS.length})::int % ${C.LONG_ANSWERS.length}])
       END,
       CASE qq.kind WHEN 'long' THEN NULL
                    WHEN 'many' THEN CASE WHEN ok.v THEN qq.points ELSE round(qq.points / jsonb_array_length(qq.correct), 2) END
                    ELSE CASE WHEN ok.v THEN qq.points ELSE 0 END END,
       CASE WHEN qq.kind = 'long' THEN LEAST(qq.points, GREATEST(1, round(qq.points * q.ability / 100.0 + (pg_temp.rnd('lp:' || q.attempt_id) - 0.5) * 2))) END,
       CASE WHEN qq.kind = 'long' AND pg_temp.rnd('ln:' || q.attempt_id) < 0.4 THEN 'Good reasoning — add one more example next time.' END,
       q.submitted - interval '2 minutes',
       CASE WHEN qq.kind = 'long' THEN q.teacher_id END, CASE WHEN qq.kind = 'long' THEN q.published_at - interval '1 hour' END
  FROM qwork q
  JOIN classwork_items i ON i.item_id = q.item_id
  JOIN quiz_questions qq ON qq.item_id = q.item_id
  CROSS JOIN LATERAL (SELECT pg_temp.rnd('qa:' || q.attempt_id || qq.sort_order) * 100 < q.ability - CASE qq.kind WHEN 'many' THEN 12 ELSE 0 END AS v) ok;
UPDATE quiz_attempts qa SET auto_score = s.auto
  FROM (SELECT attempt_id, sum(auto_points) AS auto FROM quiz_answers GROUP BY attempt_id) s
 WHERE s.attempt_id = qa.attempt_id AND qa.attempt_id IN (SELECT attempt_id FROM qwork);
CREATE TEMP TABLE qtotal ON COMMIT DROP AS
SELECT q.*, (SELECT sum(COALESCE(teacher_points, auto_points)) FROM quiz_answers x WHERE x.attempt_id = q.attempt_id) AS total FROM qwork q;
UPDATE student_assessments sa SET score = t.total, status = 'graded'
  FROM qtotal t WHERE sa.student_id = t.student_id AND sa.assessment_id = t.assessment_id;
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, draft_score, draft_status,
                                   graded_by, published_at, published_by, created_at, updated_at)
SELECT t.item_id, t.student_id, t.submitted - interval '22 minutes', t.submitted, t.submitted, FALSE, t.total, 'graded',
       t.teacher_id, t.published_at, t.teacher_id, t.submitted - interval '22 minutes', t.published_at
  FROM qtotal t;
-- Students who sign in but never took a published quiz: missing.
UPDATE student_assessments sa SET status = 'missing', score = NULL
  FROM classwork_items i JOIN assessments a ON a.assessment_id = i.assessment_id
  JOIN class_students cs ON cs.class_id = i.class_id JOIN logins l ON l.student_id = cs.student_id
 WHERE i.kind = 'quiz' AND a.is_published AND i.class_id IN (SELECT class_id FROM cls)
   AND sa.assessment_id = a.assessment_id AND sa.student_id = l.student_id
   AND NOT EXISTS (SELECT 1 FROM quiz_attempts qa WHERE qa.item_id = i.item_id AND qa.student_id = l.student_id);

-- ── Adam Haddad (student@${C.DOMAIN}): one of everything ────────────────────
CREATE TEMP TABLE adam_items ON COMMIT DROP AS
SELECT a.name, a.assessment_id, i.item_id, i.due_at, a.published_at
  FROM assessments a JOIN classwork_items i ON i.assessment_id = a.assessment_id
 WHERE a.class_id IN (${['Math', 'Language Arts', 'Science', 'Social Studies'].map(g5).join(', ')});
DELETE FROM classwork_submissions WHERE student_id = ${ADAM}
   AND item_id IN (SELECT item_id FROM adam_items WHERE name IN ('Lab 2 · States of matter', 'Community helpers chart', 'Descriptive paragraph',
       'Homework 4 · Multiplication', 'Persuasive letter', 'Reading response · Chapters 4–6', 'Quiz · Forces'));
DELETE FROM quiz_attempts WHERE student_id = ${ADAM} AND item_id IN (SELECT item_id FROM adam_items WHERE name = 'Quiz · Forces');
-- Graded, late, with feedback (and the thread in 05 is about it).
UPDATE student_assessments SET score = 16, status = 'graded'
 WHERE student_id = ${ADAM} AND assessment_id = (SELECT assessment_id FROM adam_items WHERE name = 'Lab 2 · States of matter');
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   draft_score, draft_status, feedback, feedback_saved_at, graded_by, published_at, published_by, created_at, updated_at)
SELECT item_id, ${ADAM}, due_at + interval '1 day', due_at + interval '1 day 4 hours', due_at + interval '1 day 4 hours', TRUE,
       'We heated ice in a beaker and timed how long it took to melt and then boil. The temperature stayed the same while it was melting, which surprised me.',
       due_at + interval '1 day 4 hours', 16, 'graded', 'Good observations! Next time add a sentence about what surprised you and why.',
       published_at - interval '1 hour', ${lit(staffBy.g5.id)}, published_at, ${lit(staffBy.g5.id)}, due_at + interval '1 day', published_at
  FROM adam_items WHERE name = 'Lab 2 · States of matter' AND published_at IS NOT NULL;
-- Missing.
UPDATE student_assessments SET score = NULL, status = 'missing'
 WHERE student_id = ${ADAM} AND assessment_id = (SELECT assessment_id FROM adam_items WHERE name = 'Community helpers chart');
-- Graded on time, with feedback.
UPDATE student_assessments SET score = 22, status = 'graded'
 WHERE student_id = ${ADAM} AND assessment_id = (SELECT assessment_id FROM adam_items WHERE name = 'Descriptive paragraph');
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   draft_score, draft_status, feedback, feedback_saved_at, graded_by, published_at, published_by, created_at, updated_at)
SELECT item_id, ${ADAM}, due_at - interval '2 days', due_at - interval '20 hours', due_at - interval '20 hours', FALSE,
       ${lit(C.TEXT_ANSWERS[4])}, due_at - interval '20 hours', 22, 'graded', ${lit(C.FEEDBACK[6])},
       published_at - interval '1 hour', ${lit(staffBy.g5.id)}, published_at, ${lit(staffBy.g5.id)}, due_at - interval '2 days', published_at
  FROM adam_items WHERE name = 'Descriptive paragraph' AND published_at IS NOT NULL;
-- Late but graded.
INSERT INTO classwork_submissions (item_id, student_id, opened_at, turned_in_at, first_turned_in_at, is_late, text_answer, text_saved_at,
                                   draft_score, draft_status, graded_by, published_at, published_by, created_at, updated_at)
SELECT ai.item_id, ${ADAM}, ai.due_at, ai.due_at + interval '18 hours', ai.due_at + interval '18 hours', TRUE, ${lit(C.TEXT_ANSWERS[1])},
       ai.due_at + interval '18 hours', sa.score, sa.status, ${lit(staffBy.g5.id)}, ai.published_at, ${lit(staffBy.g5.id)}, ai.due_at, ai.published_at
  FROM adam_items ai JOIN student_assessments sa ON sa.assessment_id = ai.assessment_id AND sa.student_id = ${ADAM}
 WHERE ai.name = 'Reading response · Chapters 4–6' AND ai.published_at IS NOT NULL AND sa.status = 'graded';
-- Due today, not done yet (no score either).
DELETE FROM student_assessments WHERE student_id = ${ADAM}
   AND assessment_id = (SELECT assessment_id FROM adam_items WHERE name = 'Homework 4 · Multiplication' AND published_at IS NULL);
-- A typed draft, saved but not turned in.
INSERT INTO classwork_submissions (item_id, student_id, opened_at, text_answer, text_saved_at, created_at, updated_at)
SELECT item_id, ${ADAM}, now() - interval '1 day', 'Dear Principal Karim, I think our school should have a reading buddy program because',
       now() - interval '20 hours', now() - interval '1 day', now() - interval '20 hours'
  FROM adam_items WHERE name = 'Persuasive letter' AND due_at > now();
-- A quiz started, two answers saved.
INSERT INTO quiz_attempts (attempt_id, item_id, student_id, question_order, started_at)
SELECT pg_temp.sid('attempt:adam-forces'), item_id, ${ADAM}, '{}', now() - interval '40 minutes'
  FROM adam_items WHERE name = 'Quiz · Forces' AND due_at > now();
INSERT INTO quiz_answers (attempt_id, question_id, answer, saved_at)
SELECT pg_temp.sid('attempt:adam-forces'), qq.question_id,
       CASE qq.kind WHEN 'one' THEN '{"choice":"c"}'::jsonb ELSE '{"choices":["a","b"]}'::jsonb END, now() - interval '35 minutes'
  FROM adam_items ai JOIN quiz_questions qq ON qq.item_id = ai.item_id
 WHERE ai.name = 'Quiz · Forces' AND ai.due_at > now() AND qq.sort_order IN (1, 2);
INSERT INTO classwork_submissions (item_id, student_id, opened_at, created_at, updated_at)
SELECT item_id, ${ADAM}, now() - interval '40 minutes', now() - interval '40 minutes', now() - interval '35 minutes'
  FROM adam_items WHERE name = 'Quiz · Forces' AND due_at > now();
`;

// ── 04 attendance, progress reports, JK/SK ──────────────────────────────────
const commentRows = [];
for (const [level, list] of Object.entries(C.PROGRESS_COMMENTS)) list.forEach((t, i) => commentRows.push([lit(level), i, lit(t)]));
const jkRows = [];
for (const [doc, domains] of Object.entries(C.JK_DOMAINS)) {
  domains.forEach(([domain, skills], i) => skills.forEach((skill, j) => jkRows.push([lit(doc), lit(domain), i + 1, lit(skill), j + 1])));
}
const skRows = [];
for (const [doc, subjects] of Object.entries(C.SK_SUBJECTS)) {
  subjects.forEach(([subject, standards], i) => standards.forEach((st, j) => skRows.push([lit(doc), lit(subject), i + 1, lit(st), j + 1])));
}
const laylaClasses = classes.filter((c) => c.teacher.key === 'g5').map((c) => lit(c.id));
const reports = `${CLS}${ABILITY}
-- ── Daily attendance, first day to today ────────────────────────────────────
-- Today's register is filled in for every grade except Layla Saleh's Grade 5,
-- so the teacher login has one to take.
INSERT INTO general_attendance (student_id, attendance_date, status, school)
SELECT s.student_id, sd.day,
       (CASE WHEN r.v < 1 - p.absent - p.late THEN 'PRESENT'
             WHEN r.v < 1 - p.absent THEN 'LATE' ELSE 'ABSENT' END)::attendance_status, 'PLAYGROUND'
  FROM students s CROSS JOIN ctx
  JOIN school_days sd ON sd.day <= ctx.today
  CROSS JOIN LATERAL (SELECT 0.005 + 0.05 * pg_temp.rnd('pa:' || s.student_id) AS absent,
                             0.005 + 0.04 * pg_temp.rnd('pl:' || s.student_id) AS late) p
  CROSS JOIN LATERAL (SELECT pg_temp.rnd('att:' || s.student_id || sd.day) AS v) r
 WHERE s.school_year_id = ctx.year_id AND NOT (sd.day = ctx.today AND s.grade::text = '5');
-- Adam's medical appointment (the thread in 05). Prod's attendance_status is
-- PRESENT | LATE | ABSENT only.
UPDATE general_attendance SET status = 'ABSENT' WHERE student_id = ${ADAM} AND attendance_date = DATE '2026-09-29';

-- Period attendance in Layla Saleh's classes for the last two weeks.
INSERT INTO class_attendance (class_id, student_id, attendance_date, status)
SELECT cs.class_id, cs.student_id, ga.attendance_date, ga.status
  FROM class_students cs
  JOIN general_attendance ga ON ga.student_id = cs.student_id
  CROSS JOIN ctx
 WHERE cs.class_id IN (${laylaClasses.join(', ')})
   AND ga.attendance_date >= ctx.today - 14 AND ga.attendance_date < ctx.today;

-- ── Term 1 progress report comments (Grades 1–8) ────────────────────────────
CREATE TEMP TABLE comment_tpl ON COMMIT DROP AS
SELECT * FROM (VALUES
${values(commentRows)}
) v(level, idx, body);
INSERT INTO progress_report_feedback (student_id, class_id, term, core_standards, work_habit, behavior, comment, created_at)
SELECT cs.student_id, c.class_id, ctx.term_name,
       CASE WHEN lv.v >= 85 THEN 'Exceeding Common Core Standards' WHEN lv.v >= 70 THEN 'Meeting Common Core Standards'
            WHEN lv.v >= 58 THEN 'Working towards Common Core Standards' ELSE 'Not Meeting Common Core Standards' END,
       CASE WHEN lv.v + (pg_temp.rnd('wh:' || cs.student_id || c.class_id) - 0.5) * 16 >= 85 THEN 'E'
            WHEN lv.v + (pg_temp.rnd('wh:' || cs.student_id || c.class_id) - 0.5) * 16 >= 70 THEN 'G'
            WHEN lv.v + (pg_temp.rnd('wh:' || cs.student_id || c.class_id) - 0.5) * 16 >= 58 THEN 'S' ELSE 'N' END,
       CASE WHEN lv.v + (pg_temp.rnd('bh:' || cs.student_id || c.class_id) - 0.5) * 20 >= 80 THEN 'E'
            WHEN lv.v + (pg_temp.rnd('bh:' || cs.student_id || c.class_id) - 0.5) * 20 >= 66 THEN 'G'
            WHEN lv.v + (pg_temp.rnd('bh:' || cs.student_id || c.class_id) - 0.5) * 20 >= 55 THEN 'S' ELSE 'N' END,
       replace(replace(ct.body, '{first}', split_part(s.name, ' ', 1)), '{subject}', lower(c.subject)),
       now() - make_interval(days => (pg_temp.rnd('pfd:' || cs.student_id || c.class_id) * 6)::int)
  FROM cls c
  JOIN class_students cs ON cs.class_id = c.class_id
  JOIN students s ON s.student_id = cs.student_id
  JOIN ability ab ON ab.student_id = cs.student_id
  CROSS JOIN ctx
  CROSS JOIN LATERAL (SELECT ab.ability + (pg_temp.rnd('aff:' || cs.student_id || c.subject) - 0.5) * 14 AS v) lv
  JOIN comment_tpl ct ON ct.level = CASE WHEN lv.v >= 82 THEN 'high' WHEN lv.v >= 66 THEN 'mid' ELSE 'low' END
                     AND ct.idx = (pg_temp.rnd('ct:' || cs.student_id || c.class_id) * 2)::int % 2
 WHERE c.grade NOT IN ('JK', 'SK')
   AND pg_temp.rnd('prf:' || cs.student_id || c.class_id) < CASE WHEN c.class_id = ${g5('Science')} THEN 0.5 ELSE 0.92 END;

-- ── JK and SK frameworks and Term 1 progress ratings ────────────────────────
CREATE TEMP TABLE jk_def ON COMMIT DROP AS SELECT * FROM (VALUES
${values(jkRows)}
) v(doc, domain, domain_sort, skill, skill_sort);
INSERT INTO jk_skill_domains (domain_id, document_type, name, sort_order, school)
SELECT DISTINCT pg_temp.sid('jkd:' || doc || ':' || domain), doc, domain, domain_sort, 'PLAYGROUND'::school FROM jk_def
ON CONFLICT DO NOTHING;
INSERT INTO jk_skills (skill_id, domain_id, name, sort_order)
SELECT pg_temp.sid('jks:' || doc || ':' || domain || ':' || skill), pg_temp.sid('jkd:' || doc || ':' || domain), skill, skill_sort FROM jk_def
ON CONFLICT DO NOTHING;
CREATE TEMP TABLE sk_def ON COMMIT DROP AS SELECT * FROM (VALUES
${values(skRows)}
) v(doc, subject, subject_sort, standard, standard_sort);
INSERT INTO sk_subjects (subject_id, document_type, name, sort_order, school)
SELECT DISTINCT pg_temp.sid('sks:' || doc || ':' || subject), doc, subject, subject_sort, 'PLAYGROUND'::school FROM sk_def
ON CONFLICT DO NOTHING;
INSERT INTO sk_standards (standard_id, subject_id, name, sort_order)
SELECT pg_temp.sid('skt:' || doc || ':' || subject || ':' || standard), pg_temp.sid('sks:' || doc || ':' || subject), standard, standard_sort FROM sk_def
ON CONFLICT DO NOTHING;

INSERT INTO jk_skill_assessments (student_id, skill_id, term, rating, school, assessed_by)
SELECT s.student_id, pg_temp.sid('jks:' || d.doc || ':' || d.domain || ':' || d.skill), ctx.term_name,
       CASE WHEN r.v < 0.42 + ab.ability / 400.0 THEN 'I' WHEN r.v < 0.78 THEN 'D' WHEN r.v < 0.95 THEN 'B' ELSE 'N' END,
       'PLAYGROUND', s.homeroom_teacher_id
  FROM students s CROSS JOIN ctx JOIN ability ab ON ab.student_id = s.student_id
  JOIN jk_def d ON d.doc = 'progress_report'
  CROSS JOIN LATERAL (SELECT pg_temp.rnd('jkr:' || s.student_id || d.skill) AS v) r
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'JK' AND pg_temp.rnd('jkf:' || s.student_id || d.skill) < 0.9;
INSERT INTO sk_standard_assessments (student_id, standard_id, term, rating, school, assessed_by)
SELECT s.student_id, pg_temp.sid('skt:' || d.doc || ':' || d.subject || ':' || d.standard), ctx.term_name,
       CASE WHEN r.v < 0.30 + ab.ability / 500.0 THEN 'E' WHEN r.v < 0.68 THEN 'G' WHEN r.v < 0.9 THEN 'S' WHEN r.v < 0.98 THEN 'NI' ELSE 'NA' END,
       'PLAYGROUND', s.homeroom_teacher_id
  FROM students s CROSS JOIN ctx JOIN ability ab ON ab.student_id = s.student_id
  JOIN sk_def d ON d.doc = 'progress_report'
  CROSS JOIN LATERAL (SELECT pg_temp.rnd('skr:' || s.student_id || d.standard) AS v) r
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'SK' AND pg_temp.rnd('skf:' || s.student_id || d.standard) < 0.9;
INSERT INTO jk_learning_skills (student_id, term, skill_name, rating, school)
SELECT s.student_id, ctx.term_name, ls.name,
       (ARRAY['E', 'G', 'G', 'S', 'N'])[1 + LEAST(4, (pg_temp.rnd('ls:' || s.student_id || ls.name) * 4 + (90 - ab.ability) / 25.0)::int)],
       'PLAYGROUND'
  FROM students s CROSS JOIN ctx JOIN ability ab ON ab.student_id = s.student_id
  CROSS JOIN (VALUES ${C.LEARNING_SKILLS.map((n) => `(${lit(n)})`).join(', ')}) ls(name)
 WHERE s.school_year_id = ctx.year_id AND s.grade::text IN ('JK', 'SK');
INSERT INTO jk_progress_report_comments (student_id, term, section_type, comment, school)
SELECT s.student_id, ctx.term_name, sec.k, replace(sec.body, '{first}', split_part(s.name, ' ', 1)), 'PLAYGROUND'
  FROM students s CROSS JOIN ctx
  CROSS JOIN (VALUES ${Object.entries(C.JK_COMMENTS).map(([k, b]) => `(${lit(k)}, ${lit(b)})`).join(', ')}) sec(k, body)
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'JK' AND pg_temp.rnd('jkc:' || s.student_id) < 0.7;
INSERT INTO sk_subject_comments (student_id, subject_id, term, comment, school)
SELECT s.student_id, pg_temp.sid('sks:progress_report:' || sub.name), ctx.term_name,
       split_part(s.name, ' ', 1) || sub.body, 'PLAYGROUND'
  FROM students s CROSS JOIN ctx
  CROSS JOIN (VALUES ('Mathematics', ' counts confidently to 50 and is beginning to count by tens.'),
                     ('Literacy - Reading', ' recognizes most letters and enjoys sharing books with friends.')) sub(name, body)
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'SK' AND pg_temp.rnd('skc:' || s.student_id || sub.name) < 0.6;
INSERT INTO jk_teacher_assistants (student_id, teacher_assistant_name, term, school)
SELECT s.student_id, 'Rima Khatib', ctx.term_name, 'PLAYGROUND' FROM students s CROSS JOIN ctx
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'JK';
INSERT INTO sk_teacher_assistants (student_id, teacher_assistant_name, term, school)
SELECT s.student_id, 'Dalal Youssef', ctx.term_name, 'PLAYGROUND' FROM students s CROSS JOIN ctx
 WHERE s.school_year_id = ctx.year_id AND s.grade::text = 'SK';
`;

// ── 05 announcements and messages ───────────────────────────────────────────
const byKey = (k) => staffBy[k];
const mathClub = ['5', '6', '7'].flatMap((g) => students.filter((s) => s.grade === g).sort((a, b) => ability.get(b.id) - ability.get(a.id)).slice(0, 2));
if (!mathClub.includes(adam)) mathClub[1] = adam;
const annRows = C.ANNOUNCEMENTS.map((a) => {
  const author = byKey(a.by);
  return [lit(sid(`ann:${a.key}`)), lit(a.scope), a.class ? lit(classOf(a.class[0], a.class[1]).id) : 'NULL', lit(a.grade || null),
    lit(a.title), lit(a.body), lit(author.id), lit(author.role), a.daysAgo, lit(Boolean(a.ack)), a.pinDays ? a.pinDays : 'NULL', lit(a.key)];
});
// Extra threads with other families, so the inboxes are not all Haddads.
const otherKid = (grade, i) => students.filter((s) => s.grade === grade && s.family !== haddad)[i];
const guardianOf = (kid) => (kid.family.mother?.account ? kid.family.mother : kid.family.father?.account ? kid.family.father : null);
const kidWithAccount = (grade, from = 0) => students.filter((s) => s.grade === grade && s.family !== haddad && guardianOf(s)).slice(from)[0];
const loginKid = (grade, from = 0) => students.filter((s) => s.grade === grade && s !== adam && s.login === 'active').slice(from)[0];
const extraThreads = [
  { key: 'g5-quiz-retake', kind: 'assessment', kid: kidWithAccount('5', 0), class: ['5', 'Math'], assessment: 'Quiz 2 · Operations', with: 'g5', starter: 'parent', unreadFor: 'teacher', messages: [
    ['parent', 600, 'Hello, {first} was sick the day of Quiz 2. Is it possible to write it this week?'],
  ] },
  { key: 'g6-fractions', kind: 'general', kid: kidWithAccount('6', 0), class: ['6', 'Math'], with: 'g5', starter: 'parent', title: 'Struggling with fractions', messages: [
    ['parent', 5000, 'Ms. Saleh, {first} is finding fractions really hard and gets upset at homework time. Any tips?'],
    ['teacher', 4800, 'Thanks for reaching out. {first} is trying hard! Fraction strips help a lot — I will send some home tomorrow, and {first} is welcome at extra help on Thursdays at lunch.'],
    ['parent', 4700, 'That is great, thank you.'],
  ] },
  { key: 'g5-trip-form', kind: 'general', kid: kidWithAccount('5', 1), class: ['5', 'Science'], with: 'g5', starter: 'parent', title: 'Field trip permission form', resolved: true, messages: [
    ['parent', 3000, 'We lost the permission form for the ROM trip. Can I sign something online instead?'],
    ['teacher', 2900, 'No problem — a message here is enough. I have marked {first} as allowed to go.'],
  ] },
  { key: 'g5-student-late', kind: 'student', kid: loginKid('5', 0), class: ['5', 'Language Arts'], with: 'g5', starter: 'student', title: 'Descriptive paragraph', messages: [
    ['student', 2000, 'Hi Ms. Saleh, can I hand in my descriptive paragraph tomorrow? I forgot my notebook at my grandma’s.'],
    ['teacher', 1900, 'Yes, tomorrow is fine. Thank you for letting me know!'],
  ] },
  { key: 'g8-high-school', kind: 'general', kid: kidWithAccount('8', 0), class: ['8', 'Language Arts'], with: 'g8', starter: 'parent', title: 'High school applications', messages: [
    ['parent', 8000, 'Mr. Barakat, when do we need the reference letter for the high school application?'],
    ['teacher', 7800, 'The deadline is December 4. I will have it ready by November 27.'],
  ] },
  { key: 'g3-allergy', kind: 'general', kid: kidWithAccount('3', 0), class: ['3', 'Science'], with: 'g3', starter: 'parent', title: 'Allergy reminder', unreadFor: 'teacher', messages: [
    ['parent', 300, 'Just a reminder that {first} has a peanut allergy — the class party on Friday has a lot of baked goods.'],
  ] },
  { key: 'g7-science-partner', kind: 'student', kid: loginKid('7', 0), class: ['7', 'Science'], with: 'g7', starter: 'student', title: 'Science fair partner', messages: [
    ['student', 1200, 'Ms. Kassem, can I do the science fair project with a partner from the other class?'],
    ['teacher', 1100, 'Partners have to be in our class this year, but you can work with anyone here. Let me know by Friday!'],
  ] },
  { key: 'vp-volunteer', kind: 'principal', kid: kidWithAccount('4', 0), with: 'vp', starter: 'parent', title: 'Volunteering at the fun fair', messages: [
    ['parent', 900, 'I would love to help with the bake sale at the Fun Fair. Who should I talk to?'],
    ['teacher', 850, 'Thank you! I will add you to the bake sale list — we meet in the library at 1 pm that day.'],
  ] },
];
const threads = [
  ...C.THREADS.map((t) => ({ ...t, kid: { adam, lina, sara }[t.student], guardian: t.starter === 'father' ? haddad.father : haddad.mother })),
  ...extraThreads.map((t) => ({ ...t, guardian: guardianOf(t.kid), title: t.title || t.assessment })),
];
const convRows = [];
const msgRows = [];
const partRows = [];
for (const t of threads) {
  const kid = t.kid;
  const teacher = byKey(t.with);
  const cid = sid(`thread:${t.key}`);
  const cls = t.class ? classOf(t.class[0], t.class[1]) : null;
  const studentUser = kid.userId && (t.kind === 'item' || t.kind === 'student') ? kid.userId : null;
  const who = { parent: t.guardian, father: haddad.father, teacher, student: { id: kid.userId } };
  const roleOf = { parent: 'PARENT', father: 'PARENT', teacher: teacher.role, student: 'STUDENT' };
  const last = t.messages[t.messages.length - 1];
  const creator = who[t.starter].id;
  const assessment = t.assessment && cls ? `pg_temp.sid('assessment:' || ${lit(cls.id)} || ':' || ${lit(t.assessment)})` : 'NULL';
  const item = t.kind === 'item'
    ? `(SELECT item_id FROM classwork_items WHERE assessment_id = pg_temp.sid('assessment:' || ${lit(cls.id)} || ':' || ${lit(t.item)}))`
    : 'NULL';
  convRows.push([lit(cid), lit(kid.id), cls ? lit(cls.id) : 'NULL', t.kind === 'assessment' ? assessment : 'NULL',
    lit(t.kind === 'assessment' ? 'assessment' : 'general'), lit((t.title || t.assessment).replace('{first}', kid.first)),
    lit(t.resolved ? 'resolved' : 'open'), lit(creator), t.resolved ? lit(teacher.id) : 'NULL', t.resolved ? `now() - interval '${last[1] - 5} minutes'` : 'NULL',
    `now() - interval '${last[1]} minutes'`, `now() - interval '${t.messages[0][1]} minutes'`,
    lit(teacher.id),
    lit(Boolean(studentUser)), item]);
  t.messages.forEach(([w, ago, body], i) => {
    msgRows.push([lit(sid(`msg:${t.key}:${i}`)), lit(cid), lit(who[w].id), lit(roleOf[w]), lit(body.replace(/\{first\}/g, kid.first)), `now() - interval '${ago} minutes'`]);
  });
  // Read state: everyone has read up to the last message except unreadFor.
  const parties = [['teacher', teacher.id], ['parent', t.guardian.id]];
  if (studentUser) parties.push(['student', studentUser]);
  for (const [w, id] of parties) {
    if (!id) continue;
    const unread = t.unreadFor === w || (t.unreadFor === 'parent' && w === 'parent');
    const lastOwn = [...t.messages].reverse().find(([m]) => m === w || (w === 'parent' && m === 'father'));
    const readAt = unread ? (lastOwn ? lastOwn[1] - 1 : t.messages[0][1] + 10) : last[1] - 1;
    partRows.push([lit(cid), lit(id), `now() - interval '${readAt} minutes'`]);
  }
}
const summaryRows = [
  [lit(adam.id), lit("Adam had a busy week in Grade 5. In Science, Adam's lab write-up on states of matter came back with strong marks and helpful feedback, and Adam is partway through the Forces quiz. One Social Studies assignment (the community helpers chart) is still missing — a quick reminder at home would help. The To-do list shows what is coming up next.")],
  [lit(lina.id), lit('Lina is off to a wonderful start in Grade 2. Recent spelling and reading marks are excellent, and Ms. Darwish moved Lina up a reading level this week. Keep up the nightly reading log — it is clearly paying off!')],
];
const comms = `
CREATE TEMP TABLE ann ON COMMIT DROP AS
SELECT v.id::uuid AS announcement_id, v.scope, v.class_id::uuid, v.grade, v.title, v.body, v.author_id::uuid, v.author_role,
       LEAST(pg_temp.at(ctx.today - v.days_ago, '08:20'), now() - interval '10 minutes') AS published_at, v.ack, v.pin_days, v.key
  FROM (VALUES
${values(annRows)}
  ) v(id, scope, class_id, grade, title, body, author_id, author_role, days_ago, ack, pin_days, key)
  CROSS JOIN ctx;
INSERT INTO announcements (announcement_id, school, school_year_id, scope, class_id, grade, title, body, author_id, author_role,
                           published_at, pinned_until, ack_requested, send_email, created_at)
SELECT a.announcement_id, 'PLAYGROUND', ctx.year_id, a.scope, a.class_id, a.grade, a.title, a.body, a.author_id, a.author_role,
       a.published_at, CASE WHEN a.pin_days IS NOT NULL THEN ctx.today + a.pin_days END, a.ack, FALSE, a.published_at
  FROM ann a CROSS JOIN ctx;
INSERT INTO announcement_students (announcement_id, student_id)
VALUES ${mathClub.map((s) => `(${lit(sid('ann:math-club'))}, ${lit(s.id)})`).join(', ')};

-- Who each post reaches, as parent and student accounts.
CREATE TEMP TABLE reach ON COMMIT DROP AS
SELECT DISTINCT a.announcement_id, a.key, a.published_at, a.ack, s.student_id
  FROM ann a CROSS JOIN ctx
  JOIN students s ON s.school_year_id = ctx.year_id
 WHERE (a.scope = 'school')
    OR (a.scope = 'grade' AND s.grade::text = a.grade)
    OR (a.scope = 'class' AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = a.class_id AND cs.student_id = s.student_id))
    OR (a.scope = 'custom' AND EXISTS (SELECT 1 FROM announcement_students x WHERE x.announcement_id = a.announcement_id AND x.student_id = s.student_id));
CREATE TEMP TABLE reach_users ON COMMIT DROP AS
SELECT DISTINCT r.announcement_id, r.key, r.published_at, r.ack, ps.parent_id AS user_id
  FROM reach r JOIN parent_students ps ON ps.student_id = r.student_id WHERE ps.parent_id IS NOT NULL
UNION
SELECT DISTINCT r.announcement_id, r.key, r.published_at, r.ack, sal.user_id
  FROM reach r JOIN student_account_links sal ON sal.student_id = r.student_id
  JOIN users u ON u.user_id = sal.user_id AND u.password <> '!';
-- Older posts are mostly read; the Haddads have read all but the newest.
INSERT INTO announcement_reads (announcement_id, user_id, read_at)
SELECT announcement_id, user_id, LEAST(published_at + make_interval(hours => 1 + (pg_temp.rnd('rd:' || announcement_id || user_id) * 30)::int), now())
  FROM reach_users
 WHERE CASE WHEN user_id IN (${lit(haddad.mother.id)}, ${lit(haddad.father.id)}, ${ADAM_USER})
            THEN published_at < now() - interval '2 days'
            ELSE published_at < now() - interval '1 day' AND pg_temp.rnd('r:' || announcement_id || user_id) < 0.7 END;
INSERT INTO announcement_reads (announcement_id, user_id, read_at)
SELECT a.announcement_id, u.user_id, LEAST(a.published_at + interval '3 hours', now())
  FROM ann a CROSS JOIN (VALUES (${lit(staffBy.g5.id)}::uuid), (${lit(staffBy.g6.id)}::uuid), (${lit(staffBy.ar.id)}::uuid)) u(user_id)
 WHERE a.scope = 'school' AND a.key <> 'hot-lunch'
ON CONFLICT DO NOTHING;
-- "Got it": most Grade 5 families for the trip (Amal included), a third for interviews (not Amal yet).
INSERT INTO announcement_acks (announcement_id, user_id, acked_at)
SELECT announcement_id, user_id, LEAST(published_at + make_interval(hours => 2 + (pg_temp.rnd('ak:' || announcement_id || user_id) * 40)::int), now() - interval '5 minutes')
  FROM reach_users ru
 WHERE ru.ack AND user_id NOT IN (SELECT user_id FROM users WHERE role = 'STUDENT')
   AND CASE ru.key WHEN 'g5-trip' THEN user_id = ${lit(haddad.mother.id)} OR pg_temp.rnd('ack:' || user_id) < 0.7
                   WHEN 'interviews' THEN user_id NOT IN (${lit(haddad.mother.id)}, ${lit(haddad.father.id)}) AND pg_temp.rnd('ack:' || user_id) < 0.35
                   ELSE pg_temp.rnd('ack:' || user_id || ru.key) < 0.15 END;

-- ── Message threads ─────────────────────────────────────────────────────────
INSERT INTO conversations (conversation_id, school, student_id, class_id, assessment_id, kind, title, status, created_by, resolved_by,
                           resolved_at, last_message_at, created_at, teacher_id, includes_student, classwork_item_id)
SELECT v.id::uuid, 'PLAYGROUND', v.student_id::uuid, v.class_id::uuid, v.assessment_id::uuid, v.kind, v.title, v.status, v.created_by::uuid,
       v.resolved_by::uuid, v.resolved_at::timestamptz, v.last_at, v.created, v.teacher_id::uuid, v.includes_student, v.item_id::uuid
  FROM (VALUES
${values(convRows)}
  ) v(id, student_id, class_id, assessment_id, kind, title, status, created_by, resolved_by, resolved_at, last_at, created, teacher_id,
      includes_student, item_id);
INSERT INTO messages (message_id, conversation_id, sender_id, sender_role, kind, body, created_at)
SELECT v.id::uuid, v.conversation_id::uuid, v.sender_id::uuid, v.sender_role, 'message', v.body, v.created_at
  FROM (VALUES
${values(msgRows)}
  ) v(id, conversation_id, sender_id, sender_role, body, created_at);
INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
SELECT v.conversation_id::uuid, v.user_id::uuid, v.read_at
  FROM (VALUES
${values(partRows)}
  ) v(conversation_id, user_id, read_at)
ON CONFLICT DO NOTHING;

-- This week's AI summaries for the Haddad children (the card in the parent portal).
INSERT INTO ai_weekly_summaries (student_id, week_start, content, model, generated_at)
SELECT v.student_id::uuid, date_trunc('week', ctx.today)::date, v.content, 'gpt-4o-mini', now() - interval '2 hours'
  FROM (VALUES
${values(summaryRows)}
  ) v(student_id, content) CROSS JOIN ctx;
`;

// ── 06 timetable and staff attendance ───────────────────────────────────────
const groupId = (g) => sid(`planner:group:${g}`);
const teacherPid = (k) => sid(`planner:teacher:${k}`);
const roomNames = [...new Set(timetable.map((r) => C.ROOM_OF(r.grade, r.subject)))];
const roomId = (n) => sid(`planner:room:${n}`);
const courseId = (g, s) => sid(`planner:course:${g}:${s}`);
const teachingStaff = staff.filter((s) => timetable.some((r) => r.teacher === s.key));
const fixedRows = C.FIXED_BLOCKS.flatMap(([label, days, s, e]) => days.map((d) => [lit(sid(`planner:block:${label}:${d}`)), lit(label), d, s, e]));
const courseRows = C.GRADES.flatMap((g) => timetableSubjects(g).map((s) => {
  const room = s === 'Physical Education' || s === 'Art' ? lit(roomId(C.ROOM_OF(g, s))) : 'NULL';
  const maxPerDay = s === 'Math' || s === 'Language Arts' ? 2 : C.K_HOMEROOM.includes(s) ? 4 : 1;
  return [lit(courseId(g, s)), lit(groupId(g)), lit(s), periodsPerWeek(g, s), maxPerDay, lit(teacherPid(C.leadFor(g, s))), room];
}));
const sessionRows = timetable.map((r) => [lit(groupId(r.grade)), lit(gradeLabel(r.grade)), lit(r.subject), lit(teacherPid(r.teacher)),
  lit(staffBy[r.teacher].id), lit(staffBy[r.teacher].name), lit(C.ROOM_OF(r.grade, r.subject)), r.day, r.startMin, r.endMin]);
const attendanceExceptions = [
  ['g5', '2026-10-02', 'ABSENT', null, 'Sick day'],
  ['g6', '2026-09-25', 'ABSENT', null, 'Medical appointment'],
  ['g6', '2026-10-14', 'PRESENT', 3.75, 'Left at noon'],
  ['fr', '2026-10-05', 'ABSENT', null, 'Family emergency'],
  ['fr', '2026-10-06', 'ABSENT', null, 'Family emergency'],
  ['pe', '2026-10-16', 'PRESENT', 9, 'Stayed for basketball tryouts'],
  ['g2', '2026-10-15', 'ABSENT', null, 'Professional development workshop'],
];
const planner = `
INSERT INTO planner_settings (school, school_id, default_duration_minutes, snap_minutes, school_year_id)
SELECT 'PLAYGROUND', ctx.school_id, 45, 15, ctx.year_id FROM ctx;
INSERT INTO planner_rooms (room_id, school, school_id, name, capacity_note, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.name, v.note::text, ctx.year_id
  FROM (VALUES ${roomNames.map((n) => `(${lit(roomId(n))}, ${lit(n)}, ${lit(n === 'Gym' ? 'Two classes at most' : null)})`).join(', ')}) v(id, name, note)
  CROSS JOIN ctx;
INSERT INTO planner_class_groups (class_group_id, school, school_id, name, grade, sort_order, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.name, v.grade, v.sort, ctx.year_id
  FROM (VALUES ${C.GRADES.map((g, i) => `(${lit(groupId(g))}, ${lit(gradeLabel(g))}, ${lit(g)}, ${i})`).join(', ')}) v(id, name, grade, sort)
  CROSS JOIN ctx;
INSERT INTO planner_teachers (planner_teacher_id, school, school_id, user_id, staff_id, display_name, is_full_time, max_weekly_minutes,
                              allowed_days, excluded_windows, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.user_id::uuid, v.staff_id::uuid, v.name, v.full_time, v.max_minutes, v.days, '[]'::jsonb, ctx.year_id
  FROM (VALUES
${values(teachingStaff.map((s) => [lit(teacherPid(s.key)), lit(s.id), lit(sid(`staff:${s.key}`)), lit(s.name), lit(!s.workDays),
    s.workDays ? 900 : 1500, json(s.workDays || [1, 2, 3, 4, 5])]))}
  ) v(id, user_id, staff_id, name, full_time, max_minutes, days)
  CROSS JOIN ctx;
INSERT INTO planner_courses (course_id, school, school_id, class_group_id, name, sessions_per_week, duration_minutes, max_per_day,
                             assigned_teacher_id, candidate_teacher_ids, required_room_id, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.group_id::uuid, v.name, v.per_week, 45, v.max_day, v.teacher::uuid, '[]'::jsonb, v.room::uuid, ctx.year_id
  FROM (VALUES
${values(courseRows)}
  ) v(id, group_id, name, per_week, max_day, teacher, room)
  CROSS JOIN ctx;
INSERT INTO planner_fixed_blocks (fixed_block_id, school, school_id, label, day_of_week, start_min, end_min, class_group_ids, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.label, v.day, v.s, v.e, '[]'::jsonb, ctx.year_id
  FROM (VALUES ${fixedRows.map((r) => `(${r.join(', ')})`).join(', ')}) v(id, label, day, s, e) CROSS JOIN ctx;
INSERT INTO planner_day_templates (school, school_id, day_of_week, fillable_ranges, school_year_id)
SELECT 'PLAYGROUND', ctx.school_id, d, '[{"startMin":510,"endMin":885}]'::jsonb, ctx.year_id FROM ctx, generate_series(1, 5) d;

-- The published timetable (what /my-schedule and /school-schedule read), and
-- a draft copy for the planner.
INSERT INTO planner_schedules (schedule_id, school, school_id, name, status, sessions, published_at, created_at, updated_at, school_year_id)
SELECT v.id::uuid, 'PLAYGROUND', ctx.school_id, v.name, v.status, '[]'::jsonb,
       CASE WHEN v.status = 'published' THEN pg_temp.at(ctx.term_start - 4, '15:00') END,
       pg_temp.at(ctx.term_start - 10, '11:00'), now() - interval '2 days', ctx.year_id
  FROM (VALUES (${lit(sid('planner:schedule:fall'))}, 'Fall 2026 timetable', 'published'),
               (${lit(sid('planner:schedule:winter'))}, 'Winter 2027 draft', 'draft')) v(id, name, status)
  CROSS JOIN ctx;
INSERT INTO planner_schedule_sessions (schedule_id, school, school_id, class_group_id, class_group_name, course_name, planner_teacher_id,
                                       teacher_user_id, teacher_name, room_name, day_of_week, start_min, end_min, school_year_id)
SELECT ${lit(sid('planner:schedule:fall'))}, 'PLAYGROUND', ctx.school_id, v.group_id::uuid, v.group_name, v.course, v.pt::uuid,
       v.user_id::uuid, v.teacher_name, v.room, v.day, v.s, v.e, ctx.year_id
  FROM (VALUES
${values(sessionRows)}
  ) v(group_id, group_name, course, pt, user_id, teacher_name, room, day, s, e)
  CROSS JOIN ctx;
INSERT INTO planner_schedule_fixed_blocks (schedule_id, school, school_id, class_group_ids, label, day_of_week, start_min, end_min, school_year_id)
SELECT ${lit(sid('planner:schedule:fall'))}, 'PLAYGROUND', ctx.school_id, '[]'::jsonb, b.label, b.day_of_week, b.start_min, b.end_min, ctx.year_id
  FROM planner_fixed_blocks b CROSS JOIN ctx WHERE b.school = 'PLAYGROUND' AND b.school_year_id = ctx.year_id;
-- The planner edits the schedule's own sessions list; both copies get the same week.
UPDATE planner_schedules ps
   SET sessions = (SELECT jsonb_agg(jsonb_build_object(
                     'courseId', pg_temp.sid('planner:course:' || g.grade || ':' || s.course_name), 'courseName', s.course_name,
                     'classGroupId', s.class_group_id, 'teacherId', s.planner_teacher_id,
                     'roomId', pg_temp.sid('planner:room:' || s.room_name), 'day', s.day_of_week,
                     'startMin', s.start_min, 'endMin', s.end_min) ORDER BY g.sort_order, s.day_of_week, s.start_min)
                     FROM planner_schedule_sessions s JOIN planner_class_groups g ON g.class_group_id = s.class_group_id
                    WHERE s.schedule_id = ${lit(sid('planner:schedule:fall'))})
 WHERE ps.schedule_id IN (${lit(sid('planner:schedule:fall'))}, ${lit(sid('planner:schedule:winter'))});

-- ── Staff attendance: exceptions only (the rest reads as assumed present),
-- plus today's check-in for everyone except Layla Saleh, who has it to do.
INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes, hours, created_at, updated_at)
SELECT v.teacher_id::uuid, v.day, v.status, 'PLAYGROUND', v.notes, v.hours, pg_temp.at(v.day, '08:20'), pg_temp.at(v.day, '08:20')
  FROM (VALUES
${values(attendanceExceptions.map(([k, d, st, h, n]) => [lit(staffBy[k].id), `DATE ${lit(d)}`, lit(st), h === null ? 'NULL::numeric' : h, lit(n)]))}
  ) v(teacher_id, day, status, hours, notes)
  CROSS JOIN ctx WHERE v.day <= ctx.today;
INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, created_at, updated_at)
SELECT u.user_id, ctx.today, 'PRESENT', 'PLAYGROUND', LEAST(pg_temp.at(ctx.today, '08:05'), now()), LEAST(pg_temp.at(ctx.today, '08:05'), now())
  FROM users u CROSS JOIN ctx
 WHERE u.user_id IN (${staff.filter((s) => s.key !== 'g5' && !s.workDays).map((s) => lit(s.id)).join(', ')})
   AND EXISTS (SELECT 1 FROM school_days sd WHERE sd.day = ctx.today)
ON CONFLICT DO NOTHING;
`;

// ── 07 forms and families ───────────────────────────────────────────────────
const FORM = sid('form:registration');
const fields = [
  ['first', 'text', 'Student first name', true, null], ['last', 'text', 'Student last name', true, null],
  ['dob', 'date', 'Date of birth', true, null], ['grade', 'select', 'Grade applying for', true, ['JK', 'SK', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8']],
  ['parent', 'text', 'Parent or guardian name', true, null], ['email', 'email', 'Email', true, null], ['phone', 'phone', 'Phone', true, null],
  ['previous', 'text', 'Previous school', false, null], ['heard', 'radio', 'How did you hear about us?', false, ['A friend or family member', 'Social media', 'Our masjid', 'Our website']],
  ['notes', 'textarea', 'Anything else we should know?', false, null],
];
const fieldId = (k) => sid(`form:field:${k}`);
const applicants = [
  ['Yahya', 'Kanaan', '2022-03-14', 'JK', 'Rula Kanaan', 'new', 1], ['Mila', 'Darwazeh', '2021-07-02', 'SK', 'Samah Darwazeh', 'new', 2],
  ['Omar', 'Shalabi', '2019-11-20', 'Grade 2', 'Anwar Shalabi', 'new', 3], ['Hawra', 'Tamimi', '2016-05-09', 'Grade 5', 'Manal Tamimi', 'reviewed', 5],
  ['Idris', 'Awwad', '2014-01-30', 'Grade 7', 'Jawad Awwad', 'reviewed', 8], ['Rayan', 'Hamdi', '2020-09-12', 'Grade 1', 'Rabab Hamdi', 'waitlist', 11],
  ['Laila', 'Kanaan', '2018-02-25', 'Grade 3', 'Rula Kanaan', 'new', 1], ['Ziad', 'Osman', '2017-06-18', 'Grade 4', 'Nada Osman', 'archived', 20],
  ['Safa', 'Hammoud', '2013-10-03', 'Grade 8', 'Riyad Hammoud', 'reviewed', 6],
];
const submissionRows = applicants.map(([first, last, dob, grade, parent, status, days], i) => {
  const answers = {
    [fieldId('first')]: first, [fieldId('last')]: last, [fieldId('dob')]: dob, [fieldId('grade')]: grade, [fieldId('parent')]: parent,
    [fieldId('email')]: `${slug(parent)}@${C.DOMAIN}`, [fieldId('phone')]: phone(), [fieldId('previous')]: i % 3 === 0 ? '' : 'Maple Grove Public School',
    [fieldId('heard')]: ['A friend or family member', 'Our masjid', 'Social media', 'Our website'][i % 4], [fieldId('notes')]: i === 3 ? 'Twins — applying for both.' : '',
  };
  return [lit(sid(`form:sub:${i}`)), json(answers), lit(status), days];
});
const familyRows = families.map((f) => {
  const n = f.kids.length;
  const total = n === 1 ? 550 : n === 2 ? 950 : 1300;
  return [lit(sid(`family:${f.key}:${f.no}`)), lit(`${f.surname} family`), lit(f.subsidy), f.subsidy ? Math.round(total * 0.4) : total, f.subsidy ? Math.round(total * 0.6) : 0, f.no];
});
const familyKidRows = families.flatMap((f) => f.kids.map((k) => [lit(sid(`family:${f.key}:${f.no}`)), lit(k.id)]));
const contactRows = families.flatMap((f) => ['mother', 'father'].filter((r) => f[r]).map((r) => [lit(sid(`family:${f.key}:${f.no}`)), lit(f[r].name), lit(f[r].email),
  lit(f[r].phone), lit(r), lit(r === 'mother' || !f.mother), f[r].account ? lit(f[r].id) : 'NULL']));
const extras = `
INSERT INTO registration_forms (form_id, school, title, slug, description, status, created_by, created_at, updated_at, published_at)
VALUES (${lit(FORM)}, 'PLAYGROUND', 'Registration 2027–2028', 'registration-2027-2028',
        'Apply for a spot at Playground School for September 2027. We will contact you within two weeks.', 'published',
        ${lit(ADMIN)}, now() - interval '30 days', now() - interval '30 days', now() - interval '29 days'),
       (${lit(sid('form:lunch'))}, 'PLAYGROUND', 'Hot lunch order — November', 'hot-lunch-november',
        'Choose your child''s hot lunch days for November.', 'draft', ${lit(staffBy.office.id)}, now() - interval '2 days', now() - interval '2 days', NULL);
INSERT INTO registration_form_fields (field_id, form_id, field_type, label, placeholder, is_required, options, sort_order)
SELECT v.id::uuid, ${lit(FORM)}, v.type, v.label, NULL, v.required, v.options::jsonb, v.sort
  FROM (VALUES
${values(fields.map(([k, type, label, req, opts], i) => [lit(fieldId(k)), lit(type), lit(label), lit(req), opts ? json(opts) : 'NULL::jsonb', i]))}
  ) v(id, type, label, required, options, sort);
INSERT INTO registration_form_fields (form_id, field_type, label, is_required, options, sort_order)
VALUES (${lit(sid('form:lunch'))}, 'text', 'Student name', TRUE, NULL, 0),
       (${lit(sid('form:lunch'))}, 'select', 'Grade', TRUE, ${json(C.GRADES)}, 1),
       (${lit(sid('form:lunch'))}, 'radio', 'Lunch days', TRUE, ${json(['Every day', 'Mondays and Wednesdays', 'Fridays only'])}, 2);
INSERT INTO registration_form_submissions (submission_id, form_id, school, answers, submitted_at, status)
SELECT v.id::uuid, ${lit(FORM)}, 'PLAYGROUND', v.answers, now() - make_interval(days => v.days), v.status
  FROM (VALUES
${values(submissionRows)}
  ) v(id, answers, status, days);

-- Families for Finance (tuition grid works without a QuickBooks connection).
INSERT INTO families (family_id, school, school_year_id, name, is_subsidy, is_teacher, expected_monthly_parent, expected_monthly_subsidy,
                      roster_family_no, created_by)
SELECT v.id::uuid, 'PLAYGROUND', ctx.year_id, v.name, v.subsidy, FALSE, v.parent_amt, v.subsidy_amt, v.no, ${lit(ADMIN)}
  FROM (VALUES
${values(familyRows)}
  ) v(id, name, subsidy, parent_amt, subsidy_amt, no)
  CROSS JOIN ctx;
INSERT INTO family_students (family_id, student_id)
SELECT v.family_id::uuid, v.student_id::uuid FROM (VALUES
${values(familyKidRows)}
) v(family_id, student_id);
INSERT INTO family_contacts (family_id, name, email, phone, relation, is_primary, user_id, source)
SELECT v.family_id::uuid, v.name, v.email, v.phone, v.relation, v.is_primary, v.user_id::uuid, 'student_record'
  FROM (VALUES
${values(contactRows)}
  ) v(family_id, name, email, phone, relation, is_primary, user_id);
`;

// ── write ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const sizes = {
  '00_reset.sql': file('00_reset.sql', `Removes everything the seed owns in PLAYGROUND ${C.YEAR_LABEL}.`, reset, { ctx: false }),
  '01_foundation.sql': file('01_foundation.sql', 'Year, terms, calendar, settings, accounts, students, guardians, student logins.', foundation, { ctx: false }),
  '02_gradebook.sql': file('02_gradebook.sql', 'Classes, enrolments, gradebook categories and columns, scores, publishing.', gradebook),
  '03_classwork.sql': file('03_classwork.sql', 'Assignments, quizzes, materials, submissions, quiz attempts.', classwork),
  '04_reports.sql': file('04_reports.sql', 'Attendance, progress report comments, JK/SK frameworks and ratings.', reports),
  '05_comms.sql': file('05_comms.sql', 'Announcements, reads and acks, message threads, AI summaries.', comms),
  '06_schedule.sql': file('06_schedule.sql', 'Planner config, the published timetable, staff attendance.', planner),
  '07_extras.sql': file('07_extras.sql', 'Registration forms and submissions, finance families.', extras),
};
const accounts = students.filter((s) => s.login === 'active').length;
console.log(`students ${students.length}, families ${families.length}, parent accounts ${userRows.length - staff.length - students.filter((s) => s.login).length}, student logins ${accounts} active / ${students.filter((s) => s.login === 'invited').length} invited, classes ${classes.length}, timetable periods ${timetable.length}`);
for (const [name, size] of Object.entries(sizes)) console.log(`${name.padEnd(20)} ${(size / 1024).toFixed(1)} KB`);
