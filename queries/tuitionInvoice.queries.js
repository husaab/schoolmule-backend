/*
  queries/tuitionInvoice.queries.js
  Database queries for tuition invoice management
*/

// Get all tuition invoices for a specific school
const selectTuitionInvoicesBySchool = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices
  WHERE school = $1
  ORDER BY date_due DESC, created_at DESC;
`;

// Get a specific tuition invoice by ID
const selectTuitionInvoiceById = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices 
  WHERE invoice_id = $1;
`;

// Get tuition invoices by student ID
const selectTuitionInvoicesByStudentId = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices 
  WHERE student_id = $1
  ORDER BY date_due DESC, created_at DESC;
`;

// Get tuition invoices by parent ID
const selectTuitionInvoicesByParentId = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices 
  WHERE parent_id = $1
  ORDER BY date_due DESC, created_at DESC;
`;

// Get tuition invoices by status for a school
const selectTuitionInvoicesByStatusAndSchool = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices
  WHERE school = $1 AND status = $2
  ORDER BY date_due DESC, created_at DESC;
`;

// Get overdue invoices for a school
const selectOverdueTuitionInvoicesBySchool = `
  SELECT 
    invoice_id, plan_id, student_id, student_name, student_grade,
    parent_id, parent_name, parent_email, parent_number,
    period_start, period_end, amount_due, date_due,
    amount_paid, date_paid, issued_at, status,
    created_at, last_modified_at, school
  FROM tuition_invoices
  WHERE school = $1 
    AND date_due < CURRENT_DATE 
    AND (status != 'paid' OR status IS NULL)
  ORDER BY date_due ASC;
`;

// Insert a new tuition invoice
const insertTuitionInvoice = `
  INSERT INTO tuition_invoices (
    plan_id, student_id, student_name, student_grade, parent_id, parent_name,
    parent_email, parent_number, period_start, period_end, amount_due,
    date_due, amount_paid, date_paid, issued_at, status, school
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  RETURNING *;
`;

// Update an existing tuition invoice
const updateTuitionInvoiceById = `
  UPDATE tuition_invoices 
  SET 
    student_name = COALESCE($2, student_name),
    student_grade = COALESCE($3, student_grade),
    parent_name = COALESCE($4, parent_name),
    parent_email = COALESCE($5, parent_email),
    parent_number = COALESCE($6, parent_number),
    period_start = COALESCE($7, period_start),
    period_end = COALESCE($8, period_end),
    amount_due = COALESCE($9, amount_due),
    date_due = COALESCE($10, date_due),
    amount_paid = COALESCE($11, amount_paid),
    date_paid = COALESCE($12, date_paid),
    issued_at = COALESCE($13, issued_at),
    status = COALESCE($14, status),
    last_modified_at = CURRENT_TIMESTAMP
  WHERE invoice_id = $1
  RETURNING *;
`;

// Update invoice payment information
const updateTuitionInvoicePayment = `
  UPDATE tuition_invoices 
  SET 
    amount_paid = $2,
    date_paid = $3,
    status = $4,
    last_modified_at = CURRENT_TIMESTAMP
  WHERE invoice_id = $1
  RETURNING *;
`;

// Delete a tuition invoice
const deleteTuitionInvoiceById = `
  DELETE FROM tuition_invoices 
  WHERE invoice_id = $1
  RETURNING invoice_id;
`;

// Check if invoice already exists for student in a specific billing period
const checkInvoiceExists = `
  SELECT invoice_id 
  FROM tuition_invoices 
  WHERE student_id = $1 AND plan_id = $2 AND period_start = $3 AND period_end = $4
  LIMIT 1;
`;

// Get students by school and optionally by grade
const selectStudentsBySchoolAndGrade = `
  SELECT 
    student_id, name as student_name, grade, 
    mother_name, mother_email, mother_number,
    father_name, father_email, father_number
  FROM students 
  WHERE school = $1 
    AND ($2::text IS NULL OR grade::text = $2)
  ORDER BY grade ASC, name ASC;
`;

// Get tuition plans by school and optionally by grade (active plans only)
const selectActiveTuitionPlansBySchoolAndGrade = `
  SELECT 
    plan_id, school, grade, amount, frequency, effective_from, effective_to
  FROM tuition_plans 
  WHERE school = $1 
    AND ($2::text IS NULL OR grade::text = $2)
    AND effective_from <= CURRENT_DATE 
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY grade ASC;
`;

module.exports = {
  selectTuitionInvoicesBySchool,
  selectTuitionInvoiceById,
  selectTuitionInvoicesByStudentId,
  selectTuitionInvoicesByParentId,
  selectTuitionInvoicesByStatusAndSchool,
  selectOverdueTuitionInvoicesBySchool,
  insertTuitionInvoice,
  updateTuitionInvoiceById,
  updateTuitionInvoicePayment,
  deleteTuitionInvoiceById,
  checkInvoiceExists,
  selectStudentsBySchoolAndGrade,
  selectActiveTuitionPlansBySchoolAndGrade
};