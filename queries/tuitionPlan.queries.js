/*
  queries/tuitionPlan.queries.js
  Database queries for tuition plan management
*/

// Get all tuition plans for a specific school
const selectTuitionPlansBySchool = `
  SELECT 
    plan_id, school, grade, amount, frequency, effective_from, 
    effective_to, created_at, last_modified_at
  FROM tuition_plans 
  WHERE school = $1 
  ORDER BY grade ASC, effective_from DESC;
`;

// Get a specific tuition plan by ID
const selectTuitionPlanById = `
  SELECT 
    plan_id, school, grade, amount, frequency, effective_from, 
    effective_to, created_at, last_modified_at
  FROM tuition_plans 
  WHERE plan_id = $1;
`;

// Get active tuition plans for a school (current date within effective range)
const selectActiveTuitionPlansBySchool = `
  SELECT 
    plan_id, school, grade, amount, frequency, effective_from, 
    effective_to, created_at, last_modified_at
  FROM tuition_plans 
  WHERE school = $1 
    AND effective_from <= CURRENT_DATE 
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY grade ASC;
`;

// Get tuition plans by school and grade
const selectTuitionPlansBySchoolAndGrade = `
  SELECT 
    plan_id, school, grade, amount, frequency, effective_from, 
    effective_to, created_at, last_modified_at
  FROM tuition_plans 
  WHERE school = $1 AND grade = $2 
  ORDER BY effective_from DESC;
`;

// Insert a new tuition plan
const insertTuitionPlan = `
  INSERT INTO tuition_plans (
    school, grade, amount, frequency, effective_from, effective_to
  )
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING *;
`;

// Update an existing tuition plan
const updateTuitionPlanById = `
  UPDATE tuition_plans 
  SET 
    grade = COALESCE($2, grade),
    amount = COALESCE($3, amount),
    frequency = COALESCE($4, frequency),
    effective_from = COALESCE($5, effective_from),
    effective_to = COALESCE($6, effective_to),
    last_modified_at = CURRENT_TIMESTAMP
  WHERE plan_id = $1 AND school = $7
  RETURNING *;
`;

// Delete a tuition plan
const deleteTuitionPlanById = `
  DELETE FROM tuition_plans 
  WHERE plan_id = $1 AND school = $2
  RETURNING plan_id;
`;

module.exports = {
  selectTuitionPlansBySchool,
  selectTuitionPlanById,
  selectActiveTuitionPlansBySchool,
  selectTuitionPlansBySchoolAndGrade,
  insertTuitionPlan,
  updateTuitionPlanById,
  deleteTuitionPlanById
};