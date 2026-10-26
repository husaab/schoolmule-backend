// Publishing a planner schedule, shared by the Publish button and the
// go-live worker so both behave identically.
//
// One transaction: demote the current published schedule (it keeps the bell
// times it was live with, so publishing it again later restores them), make
// this schedule's own bell times the year's live breaks/hours when it has
// them, promote it, rebuild the materialized session rows and snapshot the
// breaks. Once live, a schedule's bell times are the live config (see
// bellTimes.js), so its own copy is cleared.

const q = require('../../queries/schedulePlanner.queries');
const { liveBellTimes, applyBellTimes } = require('./bellTimes');

class PublishError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param client a connected pg client (not in a transaction); the caller releases it
 * @returns the published planner_schedules row
 */
async function publishScheduleTx(client, { scheduleId, school }) {
  await client.query('BEGIN');
  try {
    // A manual publish and the go-live worker must not interleave.
    await client.query(q.lockPlannerPublish, [school]);
    const { rows: scheduleRows } = await client.query(q.selectScheduleForUpdate, [scheduleId, school]);
    const schedule = scheduleRows[0];
    if (!schedule) throw new PublishError(404, 'Schedule not found');
    const sessions = schedule.sessions || [];
    if (sessions.length === 0) throw new PublishError(400, 'Cannot publish an empty schedule');

    const yearId = schedule.school_year_id;
    const { rows: schoolRows } = await client.query(q.selectSchoolId, [school]);
    const schoolId = schoolRows[0]?.school_id || null;

    // The outgoing schedule keeps the bell times it was live with, so
    // publishing it again (March, after the winter copy) restores them.
    const live = JSON.stringify(await liveBellTimes(client, school, yearId));
    const { rows: demoted } = await client.query(q.demotePublishedSchedules, [school, yearId, scheduleId, live]);
    for (const row of demoted) {
      await client.query(q.deleteSessionsForSchedule, [row.schedule_id]);
      await client.query(q.deleteFixedBlocksForSchedule, [row.schedule_id]);
    }

    if (schedule.bell_times) {
      await applyBellTimes(client, { school, schoolId, yearId, bellTimes: schedule.bell_times });
    }

    // Blocks are read after applyBellTimes so the snapshot has the new times.
    const [teachersQ, groupsQ, roomsQ, blocksQ] = await Promise.all([
      client.query(q.selectTeachersBySchool, [school, yearId]),
      client.query(q.selectClassGroupsBySchool, [school, yearId]),
      client.query(q.selectRoomsBySchool, [school, yearId]),
      client.query(q.selectFixedBlocksBySchool, [school, yearId]),
    ]);
    const teacherById = new Map(teachersQ.rows.map((r) => [r.planner_teacher_id, r]));
    const groupById = new Map(groupsQ.rows.map((r) => [r.class_group_id, r]));
    const roomById = new Map(roomsQ.rows.map((r) => [r.room_id, r]));

    const { rows: published } = await client.query(q.markSchedulePublished, [scheduleId, school]);
    await client.query(q.deleteSessionsForSchedule, [scheduleId]);
    for (const s of sessions) {
      const teacher = teacherById.get(s.teacherId);
      const group = groupById.get(s.classGroupId);
      const room = s.roomId ? roomById.get(s.roomId) : null;
      await client.query(q.insertScheduleSession, [
        scheduleId,
        school,
        schoolId,
        group ? s.classGroupId : null,
        group?.name || 'Unknown class',
        s.courseName || 'Course',
        teacher ? s.teacherId : null,
        teacher?.user_id || null,
        teacher?.display_name || 'Unknown teacher',
        room?.name || null,
        s.day,
        s.startMin,
        s.endMin,
        yearId,
      ]);
    }
    // Breaks are snapshotted too: teachers read them from here, not from the
    // admin-only planner_fixed_blocks config.
    await client.query(q.deleteFixedBlocksForSchedule, [scheduleId]);
    for (const b of blocksQ.rows) {
      await client.query(q.insertScheduleFixedBlock, [
        scheduleId,
        school,
        schoolId,
        JSON.stringify(b.class_group_ids || []),
        b.label,
        b.day_of_week,
        b.start_min,
        b.end_min,
        yearId,
      ]);
    }
    await client.query('COMMIT');
    return published[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { publishScheduleTx, PublishError };
