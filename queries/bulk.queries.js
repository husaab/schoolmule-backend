// queries/bulk.queries.js

const bulkQueries = {
  /**
   * 1) Enroll every student in a given grade into a class.
   *    $1 = class_id (UUID)
   *    $2 = grade    (integer)
   */
  enrollAllInGrade: `
    INSERT INTO class_students (class_id, student_id)
    SELECT
      $1     AS class_id,
      student_id
    FROM students
    WHERE grade = $2
        AND school = $3
    ON CONFLICT DO NOTHING
  `,

  /**
   * 2) Enroll a specific list of student IDs into a class.
   *    $1 = class_id      (UUID)
   *    $2 = uuid[] array  (array of student_ids)
   *
   * We rely on the driver to send a real UUID[] for $2.
   */
  enrollSpecificStudents: `
    INSERT INTO class_students (class_id, student_id)
    SELECT
      $1::uuid,
      unnest($2::uuid[])
    ON CONFLICT DO NOTHING
  `,

  /**
   * 3) Return exactly which student_ids from a provided array are now in class_students.
   *    $1 = class_id      (UUID)
   *    $2 = uuid[] array  (array of student_ids)
   *
   * We again treat $2 as uuid[] so that ANY($2) works as expected.
   */
  selectEnrolledSpecificStudents: `
    SELECT student_id
    FROM class_students
    WHERE class_id = $1::uuid
      AND student_id = ANY($2::uuid[])
  `,

  /**
   * 4) Unenroll EVERY student from a given class.
   *    $1 = class_id (UUID)
   */
  unenrollAllFromClass: `
    DELETE FROM class_students
    WHERE class_id = $1::uuid
  `,
};

module.exports = bulkQueries;
