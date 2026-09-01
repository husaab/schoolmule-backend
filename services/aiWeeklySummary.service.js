// services/aiWeeklySummary.service.js
//
// The parent dashboard's "how was my child's week" paragraph.
//
// Generated on demand on the first dashboard view of a given week and
// cached per (student, week), so a family that checks daily costs one
// OpenAI call per week, and a family that never logs in costs nothing.
// Publishing new marks mid-week drops the cached row so the next view
// reflects them.
//
// Every number handed to the model comes from analyticsEngine and the same
// queries the parent portal itself uses — this file never computes a grade.
//
// Failures are never cached and never thrown: the dashboard renders fine
// without a summary. If OPENAI_API_KEY is absent (it lives in the frontend
// env today and must be added to the Railway backend service), the feature
// degrades to "unavailable" rather than erroring.

const db = require('../config/database');
const logger = require('../logger');
const engine = require('./analyticsEngine');
const aiQueries = require('../queries/aiWeeklySummary.queries');
const parentPortalQueries = require('../queries/parentPortal.queries');
const progressReportQueries = require('../queries/progressReports.queries');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const NO_ACTIVITY_MODEL = 'none';
const SCHOOL_TIMEZONE = 'America/Toronto';

const SYSTEM_PROMPT = `You are a warm, factual school communications assistant. You write short weekly summaries for parents about their child's week at school. You must never invent facts — only describe what is explicitly provided to you. If information is missing or thin, acknowledge that plainly instead of guessing. Keep every summary to 2-4 sentences, addressed directly to the parent, in a warm but professional tone.`;

// ────────────────────────────────────────────────────────────────────
// Week boundaries
// ────────────────────────────────────────────────────────────────────

/** Today's date in the school's timezone, as YYYY-MM-DD. */
function schoolToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Monday of the current school week, as YYYY-MM-DD. */
function getWeekStart(now = new Date()) {
  const today = schoolToday(now);
  // Anchor at noon UTC so the arithmetic below can't slip a day via DST.
  const d = new Date(`${today}T12:00:00Z`);
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const formatDayLabel = (isoDate) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-CA', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

// ────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────

/**
 * Drop this week's cached summary for the given students. Called after a
 * publish, so newly released marks show up in the next summary instead of
 * waiting out the week.
 */
async function invalidateWeeklySummaries(studentIds, now = new Date()) {
  if (!studentIds || studentIds.length === 0) return;
  try {
    await db.query(aiQueries.deleteSummariesForWeek, [studentIds, getWeekStart(now)]);
  } catch (error) {
    // A stale summary is a cosmetic problem; never fail a publish over it.
    logger.warn('Could not invalidate weekly AI summaries:', error);
  }
}

// ────────────────────────────────────────────────────────────────────
// Fact gathering
// ────────────────────────────────────────────────────────────────────

/**
 * Everything the model is allowed to talk about, for one student, for the
 * current week. Grades come from the published-only matrix, so the summary
 * can never mention a mark the parent cannot see in the portal.
 */
async function gatherWeekFacts({ school, studentId, termId, engineName, weekStart, weekEnd }) {
  const facts = {
    studentName: null,
    newMarks: [],
    attendance: null,
    missingWork: [],
    feedback: [],
  };

  let breakdown = null;
  if (termId) {
    const matrix = await engine.buildAnalyticsMatrix(school, termId, engineName, {
      publishedOnly: true,
    });
    breakdown = engine.getStudentClassBreakdown(matrix, studentId);
  }

  if (breakdown) {
    facts.studentName = breakdown.studentName;

    for (const cls of breakdown.classes) {
      for (const a of cls.assessmentScores) {
        if (!a.publishedAt) continue;
        const publishedDay = String(a.publishedAt).slice(0, 10);
        if (publishedDay < weekStart || publishedDay > weekEnd) continue;
        // Categories are represented by their rollup; children roll into them.
        if (a.parentAssessmentId) continue;

        const pct = a.isParent
          ? a.rollupPct
          : a.score != null && a.maxScore
            ? Math.round((a.score / a.maxScore) * 1000) / 10
            : null;
        if (pct == null) continue;

        facts.newMarks.push({ subject: cls.subject, name: a.name, pct });
      }
    }

    facts.missingWork = breakdown.missingWork
      .filter((m) => !m.isParent)
      .map((m) => ({ subject: m.subject, name: m.assessmentName }));
  }

  const [attendanceResult, feedbackResult] = await Promise.allSettled([
    db.query(parentPortalQueries.selectStudentAttendanceRange, [
      studentId,
      school,
      weekStart,
      weekEnd,
    ]),
    db.query(progressReportQueries.getStudentProgressReportFeedback, [studentId]),
  ]);

  if (attendanceResult.status === 'fulfilled') {
    const rows = attendanceResult.value.rows;
    if (rows.length > 0) {
      facts.attendance = {
        present: rows.filter((r) => r.status === 'PRESENT').length,
        late: rows.filter((r) => r.status === 'LATE').length,
        absent: rows.filter((r) => r.status === 'ABSENT').length,
        total: rows.length,
      };
    }
  } else {
    logger.warn('Weekly summary: attendance lookup failed', attendanceResult.reason);
  }

  if (feedbackResult.status === 'fulfilled') {
    facts.feedback = feedbackResult.value.rows
      .filter((r) => {
        if (!r.created_at) return false;
        const day = new Date(r.created_at).toISOString().slice(0, 10);
        return day >= weekStart && day <= weekEnd;
      })
      .map((r) => ({ subject: r.subject, comment: r.comment }))
      .filter((f) => f.comment);
  } else {
    logger.warn('Weekly summary: feedback lookup failed', feedbackResult.reason);
  }

  return facts;
}

const hasActivity = (facts) =>
  facts.newMarks.length > 0 ||
  facts.missingWork.length > 0 ||
  facts.feedback.length > 0 ||
  (facts.attendance != null && facts.attendance.total > 0);

// ────────────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────────────

function buildUserPrompt(facts, studentName, weekStart, weekEnd) {
  const marks = facts.newMarks.length
    ? facts.newMarks.map((m) => `- ${m.subject}: ${m.name} — ${m.pct}%`).join('\n')
    : 'None';

  let attendance = 'No attendance recorded this week.';
  if (facts.attendance) {
    const { present, late, absent, total } = facts.attendance;
    attendance = `${present} present, ${late} late, ${absent} absent, out of ${total} recorded day(s).`;
  }

  const missing = facts.missingWork.length
    ? facts.missingWork.map((m) => `- ${m.subject}: ${m.name}`).join('\n')
    : 'None';

  const feedback = facts.feedback.length
    ? facts.feedback.map((f) => `- ${f.subject}: ${f.comment}`).join('\n')
    : 'None';

  return `Write a short weekly update for the parent of ${studentName} covering ${formatDayLabel(weekStart)} to ${formatDayLabel(weekEnd)}.

Only use the facts below. Do not mention any subject, grade, or event that is not listed. If a section has no items, simply don't mention that topic.

Newly published grades this week:
${marks}

Attendance this week:
${attendance}

Missing or outstanding work:
${missing}

New teacher feedback this week:
${feedback}

Guidelines:
- 2 to 4 sentences total.
- Address the parent directly (e.g., "This week, ${studentName} ...").
- Be warm and factual — celebrate genuine wins, note concerns gently, never invent numbers or subjects.
- If there is very little information above, write a brief, honest summary rather than padding it out.
- Do not use bullet points or headers — write flowing sentences.
- Do not include raw percentages beyond what's given; you may round or describe qualitatively.

Write only the summary text, no labels or preamble.`;
}

// ────────────────────────────────────────────────────────────────────
// Generation
// ────────────────────────────────────────────────────────────────────

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY is not set on the backend — weekly summaries are unavailable');
    return null;
  }

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 220,
      temperature: 0.6,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  return content || null;
}

/**
 * The cached summary for a student's current week, generating it if this is
 * the first request this week.
 *
 * Returns { content, weekStart, weekEnd, generatedAt, model, unavailable }.
 * unavailable = true means generation failed (or no API key) — the caller
 * should still respond 200 and the dashboard should render without it.
 * Nothing is cached in that case, so the next view retries.
 */
async function getOrGenerateWeeklySummary({
  school,
  studentId,
  studentName,
  termId,
  engineName,
  now = new Date(),
}) {
  const weekStart = getWeekStart(now);
  const weekEnd = addDays(weekStart, 6);
  const base = { weekStart, weekEnd };

  try {
    const { rows } = await db.query(aiQueries.selectCachedSummary, [studentId, weekStart]);
    if (rows.length > 0) {
      return {
        ...base,
        content: rows[0].content,
        model: rows[0].model,
        generatedAt: rows[0].generated_at,
        unavailable: false,
      };
    }
  } catch (error) {
    logger.warn('Weekly summary cache read failed, regenerating:', error);
  }

  let facts;
  try {
    facts = await gatherWeekFacts({ school, studentId, termId, engineName, weekStart, weekEnd });
  } catch (error) {
    logger.error('Weekly summary fact gathering failed:', error);
    return { ...base, content: null, model: null, generatedAt: null, unavailable: true };
  }

  const name = facts.studentName || studentName || 'your child';

  // Quiet week: no OpenAI call at all. Still cached, so we don't re-check
  // on every dashboard load.
  if (!hasActivity(facts)) {
    const content = `No new grades, attendance updates, or feedback for ${name} this week — check back soon.`;
    return persist({ studentId, weekStart, weekEnd, content, model: NO_ACTIVITY_MODEL });
  }

  let content;
  try {
    content = await callOpenAI(buildUserPrompt(facts, name, weekStart, weekEnd));
  } catch (error) {
    logger.error('Weekly summary generation failed:', error);
    return { ...base, content: null, model: null, generatedAt: null, unavailable: true };
  }

  if (!content) {
    return { ...base, content: null, model: null, generatedAt: null, unavailable: true };
  }

  return persist({ studentId, weekStart, weekEnd, content, model: MODEL });
}

async function persist({ studentId, weekStart, weekEnd, content, model }) {
  try {
    const { rows } = await db.query(aiQueries.upsertSummary, [
      studentId,
      weekStart,
      content,
      model,
    ]);
    return {
      weekStart,
      weekEnd,
      content,
      model,
      generatedAt: rows[0]?.generated_at || new Date().toISOString(),
      unavailable: false,
    };
  } catch (error) {
    // Return the text anyway — failing to cache is not failing to summarise.
    logger.warn('Could not cache weekly AI summary:', error);
    return {
      weekStart,
      weekEnd,
      content,
      model,
      generatedAt: new Date().toISOString(),
      unavailable: false,
    };
  }
}

module.exports = {
  getOrGenerateWeeklySummary,
  invalidateWeeklySummaries,
  // exported for unit testing
  getWeekStart,
  gatherWeekFacts,
  buildUserPrompt,
  hasActivity,
};
