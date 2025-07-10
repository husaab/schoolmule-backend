/*
  queries/staff.queries.js
  Database queries for staff management
*/

// Get all staff for a specific school
const selectStaffBySchool = `
  SELECT 
    staff_id, school, full_name, staff_role, teaching_assignments,
    homeroom_grade, email, phone, preferred_contact, 
    phone_contact_hours, email_contact_hours, created_at
  FROM staff 
  WHERE school = $1 
  ORDER BY full_name ASC;
`;

// Get a specific staff member by ID
const selectStaffById = `
  SELECT 
    staff_id, school, full_name, staff_role, teaching_assignments,
    homeroom_grade, email, phone, preferred_contact, 
    phone_contact_hours, email_contact_hours, created_at
  FROM staff 
  WHERE staff_id = $1;
`;

// Insert a new staff member
const insertStaff = `
  INSERT INTO staff (
    school, full_name, staff_role, teaching_assignments,
    homeroom_grade, email, phone, preferred_contact,
    phone_contact_hours, email_contact_hours
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING *;
`;

// Update an existing staff member
const updateStaffById = `
  UPDATE staff 
  SET 
    full_name = COALESCE($2, full_name),
    staff_role = COALESCE($3, staff_role),
    teaching_assignments = COALESCE($4, teaching_assignments),
    homeroom_grade = COALESCE($5, homeroom_grade),
    email = COALESCE($6, email),
    phone = COALESCE($7, phone),
    preferred_contact = COALESCE($8, preferred_contact),
    phone_contact_hours = COALESCE($9, phone_contact_hours),
    email_contact_hours = COALESCE($10, email_contact_hours)
  WHERE staff_id = $1 AND school = $11
  RETURNING *;
`;

// Delete a staff member
const deleteStaffById = `
  DELETE FROM staff 
  WHERE staff_id = $1 AND school = $2
  RETURNING staff_id;
`;

module.exports = {
  selectStaffBySchool,
  selectStaffById,
  insertStaff,
  updateStaffById,
  deleteStaffById
};