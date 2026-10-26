// A schedule's bell times: the breaks (fixed blocks) and school hours (day
// templates) it was made for.
//
// While a schedule is live, the year's planner config IS its bell times, so
// editing a break in settings and republishing works as it always has. A
// draft can carry its own (planner_schedules.bell_times): a "Copy with new
// times" copy, or a schedule that was live and got replaced — it keeps the
// times it was live with, so publishing it again restores them.

const q = require('../../queries/schedulePlanner.queries');

const blockFromRow = (row) => ({
  classGroupIds: row.class_group_ids || [],
  label: row.label,
  dayOfWeek: row.day_of_week,
  startMin: row.start_min,
  endMin: row.end_min,
});

const dayTemplateFromRow = (row) => ({
  dayOfWeek: row.day_of_week,
  fillableRanges: row.fillable_ranges || [],
});

/** The year's live breaks and school hours. */
async function liveBellTimes(db, school, yearId) {
  const [blocks, days] = await Promise.all([
    db.query(q.selectFixedBlocksBySchool, [school, yearId]),
    db.query(q.selectDayTemplatesBySchool, [school, yearId]),
  ]);
  return {
    fixedBlocks: blocks.rows.map(blockFromRow),
    dayTemplates: days.rows.map(dayTemplateFromRow),
  };
}

/** A schedule's own bell times, or the live ones when it has none. */
const bellTimesOf = (db, schedule) =>
  schedule.bell_times ? Promise.resolve(schedule.bell_times) : liveBellTimes(db, schedule.school, schedule.school_year_id);

/** Make `bellTimes` the year's live breaks and school hours (inside a txn). */
async function applyBellTimes(client, { school, schoolId, yearId, bellTimes }) {
  await client.query(q.deleteFixedBlocksBySchoolYear, [school, yearId]);
  for (const b of bellTimes.fixedBlocks || []) {
    await client.query(q.insertFixedBlock, [
      school, schoolId, JSON.stringify(b.classGroupIds || []), b.label, b.dayOfWeek, b.startMin, b.endMin, yearId,
    ]);
  }
  await client.query(q.deleteDayTemplatesBySchool, [school, yearId]);
  for (const d of bellTimes.dayTemplates || []) {
    await client.query(q.insertDayTemplate, [school, schoolId, d.dayOfWeek, JSON.stringify(d.fillableRanges || []), yearId]);
  }
}

module.exports = { liveBellTimes, bellTimesOf, applyBellTimes };
