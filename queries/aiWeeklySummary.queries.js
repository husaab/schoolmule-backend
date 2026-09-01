// queries/aiWeeklySummary.queries.js
//
// Cache for the parent dashboard's AI weekly summary. One row per
// (student, week_start). Written on the first dashboard view that week and
// deleted when new marks are published mid-week, so the next view
// regenerates against current data.

const aiWeeklySummaryQueries = {
  /** Params: $1 student_id, $2 week_start (DATE) */
  selectCachedSummary: `
    SELECT student_id, week_start, content, model, generated_at
    FROM ai_weekly_summaries
    WHERE student_id = $1
      AND week_start = $2
  `,

  /** Params: $1 student_id, $2 week_start, $3 content, $4 model */
  upsertSummary: `
    INSERT INTO ai_weekly_summaries (student_id, week_start, content, model)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (student_id, week_start)
    DO UPDATE SET content      = EXCLUDED.content,
                  model        = EXCLUDED.model,
                  generated_at = NOW()
    RETURNING student_id, week_start, content, model, generated_at
  `,

  /** Params: $1 student_id[], $2 week_start */
  deleteSummariesForWeek: `
    DELETE FROM ai_weekly_summaries
    WHERE student_id = ANY($1::uuid[])
      AND week_start = $2
  `,
};

module.exports = aiWeeklySummaryQueries;
