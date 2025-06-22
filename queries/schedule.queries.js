const scheduleQueries = {
  selectSchedulesBySchool: `
    SELECT *
    FROM public.schedules
    WHERE school = $1 AND week_start_date = $2
    ORDER BY grade, day_of_week, start_time
  `,

  selectSchedulesByGrade: `
    SELECT *
    FROM public.schedules
    WHERE school = $1 AND grade = $2 AND week_start_date = $3
    ORDER BY day_of_week, start_time
  `,

  createSchedule: `
    INSERT INTO public.schedules (
      school,
      grade,
      day_of_week,
      start_time,
      end_time,
      subject,
      teacher_name,
      is_lunch,
      lunch_supervisor,
      week_start_date
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `,

  updateScheduleById: `
    UPDATE public.schedules
    SET
      school = COALESCE($1, school),
      grade = COALESCE($2, grade),
      day_of_week = COALESCE($3, day_of_week),
      start_time = COALESCE($4, start_time),
      end_time = COALESCE($5, end_time),
      subject = COALESCE($6, subject),
      teacher_name = COALESCE($7, teacher_name),
      is_lunch = COALESCE($8, is_lunch),
      lunch_supervisor = COALESCE($9, lunch_supervisor),
      week_start_date = COALESCE($10, week_start_date),
      updated_at = NOW()
    WHERE schedule_id = $11
    RETURNING *
  `,

  deleteScheduleById: `
    DELETE FROM public.schedules
    WHERE schedule_id = $1
  `,
};

module.exports = scheduleQueries;
