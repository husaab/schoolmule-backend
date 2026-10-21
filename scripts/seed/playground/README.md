# PLAYGROUND seed

A whole synthetic school in the **PLAYGROUND** tenant's **2026-2027** year, for
testing the web and iOS apps against realistic data. Every person is fictional
and every address is on the reserved `playground.test` domain, which the
backend never emails (`utils/emailUtils.js`), so workers and test actions can't
bounce mail through Resend.

## Accounts

Password for every seeded login: **`Playground2026!`**

| Role | Email | Who |
|---|---|---|
| Admin | `admin@playground.test` | Nadia Karim, Principal (full admin) |
| Teacher | `teacher@playground.test` | Layla Saleh: Grade 5 homeroom (Math, Language Arts, Science, Social Studies) and Grade 6 Math; co-teaches G5 Science with Bilal Hamdan |
| Parent | `parent@playground.test` | Amal Haddad: mother of Adam (Grade 5), Lina (Grade 2) and Sara (SK) |
| Student | `student@playground.test` | Adam Haddad, Grade 5 |

Other logins on the same password, for when you need another view:

- `yusuf.rahman@playground.test` is the Vice Principal (ADMIN), who also teaches Grade 7 Math.
- `huda.saleem@playground.test` is the Office Manager (ADMIN with the "Office Staff" role, so no grades and no finance).
- `karim.haddad@playground.test` is Adam's father, a second guardian on the same children.
- Every other teacher is `first.last@playground.test` (e.g. `omar.farouk@playground.test`).
- Parents are `first.last@playground.test`; students are `first.last@students.playground.test`.
  - Grade 5: every student has an active login.
  - Grades 6–8: most have an active login, a few are invited (password `!`), the rest have none.

## What is in it

- **People**
  - 110 students (JK–Grade 8) in 73 families, with guardians, addresses, birthdays, OENs, a few medical notes and avatars.
  - 76 parent accounts; some families have no account, some have an invite out.
  - 19 staff (one part-timer: Nour Khoury, Mon/Tue/Thu).
  - Approvals has 2 parent sign-ups and 1 teacher sign-up waiting. Student requests has 2 pending.
- **Classes**
  - 78 classes: 9 subjects per grade, plus Kindergarten, Arabic and Islamic Studies in JK/SK.
  - Weighted gradebook categories and about 11–19 columns per class across Term 1.
  - Everything older than four days is scored and published, with ~3% missing and ~2% excused.
  - The last four days are scored but still drafts; today's column is partly entered.
- **Classwork (Grades 5–8)**
  - Assignments: Mark-as-done, typed answers and labs (file upload for upcoming ones).
  - 4 Science quizzes with all four question kinds.
  - Materials with links, plus a draft and a scheduled post in Layla's Grade 5 Science.
  - Submissions: on time, late, missing, turned in waiting for review, draft-graded, and published with feedback.
- **Adam's story** (`student@`): one of everything.
  - Graded late lab with feedback, and a graded paragraph with feedback.
  - A missing Social Studies chart.
  - Homework due today.
  - A typed draft that isn't turned in, and a quiz in progress.
  - A private thread with Layla about the late lab.
- **Attendance**
  - Daily attendance from the first day to today (about 93% present).
  - **Today is left blank for Grade 5**, so the teacher login has a register to take.
  - Period attendance in Layla's classes for two weeks.
- **Reports**
  - Term 1 progress-report comments for Grades 1–8; Layla's G5 Science is half done.
  - JK/SK skill frameworks, ratings, learning skills, comments and TAs.
- **Communication**
  - 17 announcements (school, grade, class and custom), with reads and "Got it" acks.
  - 15 message threads: parent↔teacher, assessment threads, student threads, principal and VP. Some are unread or need a reply.
  - This week's AI summaries for Adam and Lina.
- **Schedule**
  - 32 calendar events, including closures, PA days and Eid.
  - A clash-free published timetable (340 periods, with recess, lunch & salah, and Jumu'ah on Friday), plus a draft copy in the planner.
- **Staff**
  - Monthly pay schedule (25th) and a few staff absences or half days.
  - **Layla has not checked in today**, so the check-in prompt shows.
- **Extras**
  - A published registration form with 9 applications and a draft form.
  - Finance families and contacts.

## Re-running

Dates are worked out from the day the SQL runs (America/Toronto). Re-running
gives you the school "as of" that day: new due dates, attendance up to today,
today's check-ins, and this week's AI summary.

```bash
cd schoolmule-backend
node scripts/seed/playground/generate.js          # only if you changed content.js / generate.js
node scripts/seed/playground/run.js --env .env --confirm
node scripts/seed/playground/smoke.js https://schoolmule-backend-production.up.railway.app/api
```

You can also paste `sql/00_reset.sql` … `sql/07_extras.sql`, in order, into the
Supabase SQL editor.

- **What the reset deletes:** `00_reset.sql` removes everything in PLAYGROUND 2026-2027 and the `@playground.test` accounts. School-level rows (classroom settings, pay schedule, the Office Staff role, the JK/SK frameworks) are upserted on every run and never deleted.
- **Time decay:** due dates are fixed weeks of the term, so as days pass, work the seed left unsubmitted turns Missing for students who sign in. Re-run the seed before a test session to get a fresh "today".
- **What it never touches:** 2025-2026, and any other account or school.
- **Term 2:** if you run it after Feb 1, 2027, Term 2 becomes the active term and the classes are created in Term 2.
- **Analytics cache:** the backend holds analytics in memory for 5 minutes (and the dashboard's average grade for 24 hours), so freshly seeded grades can take a few minutes to show in charts.
