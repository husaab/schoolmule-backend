/*
  controllers/tuitionInvoice.controller.js
  Controller for tuition invoice management operations
*/

const db = require("../config/database");
const tuitionInvoiceQueries = require("../queries/tuitionInvoice.queries");
const logger = require("../logger");

// Convert database row to camelCase
const toCamel = row => ({
  invoiceId: row.invoice_id,
  planId: row.plan_id,
  studentId: row.student_id,
  studentName: row.student_name,
  studentGrade: row.student_grade,
  parentId: row.parent_id,
  parentName: row.parent_name,
  parentEmail: row.parent_email,
  parentNumber: row.parent_number,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  amountDue: row.amount_due,
  dateDue: row.date_due,
  amountPaid: row.amount_paid,
  datePaid: row.date_paid,
  issuedAt: row.issued_at,
  status: row.status,
  createdAt: row.created_at,
  lastModifiedAt: row.last_modified_at,
  school: row.school
});

// GET /api/tuition-invoices?school=<school>
const getTuitionInvoicesBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectTuitionInvoicesBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition invoices" 
    });
  }
};

// GET /api/tuition-invoices/:invoiceId
const getTuitionInvoiceById = async (req, res) => {
  const { invoiceId } = req.params;
  if (!invoiceId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: invoiceId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectTuitionInvoiceById, [invoiceId]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition invoice not found" 
      });
    }
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition invoice" 
    });
  }
};

// GET /api/tuition-invoices/student/:studentId
const getTuitionInvoicesByStudentId = async (req, res) => {
  const { studentId } = req.params;
  if (!studentId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: studentId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectTuitionInvoicesByStudentId, [studentId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching student tuition invoices" 
    });
  }
};

// GET /api/tuition-invoices/parent/:parentId
const getTuitionInvoicesByParentId = async (req, res) => {
  const { parentId } = req.params;
  if (!parentId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: parentId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectTuitionInvoicesByParentId, [parentId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching parent tuition invoices" 
    });
  }
};

// GET /api/tuition-invoices/status/:status?school=<school>
const getTuitionInvoicesByStatusAndSchool = async (req, res) => {
  const { status } = req.params;
  const { school } = req.query;
  
  if (!status || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameters: status and school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectTuitionInvoicesByStatusAndSchool, [school, status]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition invoices by status" 
    });
  }
};

// GET /api/tuition-invoices/overdue?school=<school>
const getOverdueTuitionInvoicesBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.selectOverdueTuitionInvoicesBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching overdue tuition invoices" 
    });
  }
};

// POST /api/tuition-invoices
const createTuitionInvoice = async (req, res) => {
  const {
    planId, studentId, studentName, studentGrade, parentId, parentName,
    parentEmail, parentNumber, periodStart, periodEnd, amountDue,
    dateDue, amountPaid, datePaid, issuedAt, status, school
  } = req.body;

  if (!planId || !studentId || !studentName || !periodStart || !periodEnd || !amountDue || !dateDue || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: planId, studentId, studentName, periodStart, periodEnd, amountDue, dateDue, school" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceQueries.insertTuitionInvoice,
      [
        planId, studentId, studentName, studentGrade, parentId, parentName,
        parentEmail, parentNumber, periodStart, periodEnd, amountDue,
        dateDue, amountPaid || null, datePaid || null, issuedAt || null, status || 'pending', school
      ]
    );

    logger.info(`Tuition invoice created for student ${studentName}: $${amountDue}`);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error creating tuition invoice" 
    });
  }
};

// PATCH /api/tuition-invoices/:invoiceId
const updateTuitionInvoice = async (req, res) => {
  const { invoiceId } = req.params;
  const {
    studentName, studentGrade, parentName, parentEmail, parentNumber,
    periodStart, periodEnd, amountDue, dateDue, amountPaid, datePaid,
    issuedAt, status
  } = req.body;

  if (!invoiceId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing invoiceId" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceQueries.updateTuitionInvoiceById,
      [
        invoiceId, studentName, studentGrade, parentName, parentEmail,
        parentNumber, periodStart, periodEnd, amountDue, dateDue,
        amountPaid, datePaid, issuedAt, status
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition invoice not found" 
      });
    }

    logger.info(`Tuition invoice updated: ${invoiceId}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error updating tuition invoice" 
    });
  }
};

// PATCH /api/tuition-invoices/:invoiceId/payment
const updateTuitionInvoicePayment = async (req, res) => {
  const { invoiceId } = req.params;
  const { amountPaid, datePaid, status } = req.body;

  if (!invoiceId || amountPaid === undefined || !datePaid || !status) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: amountPaid, datePaid, status" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionInvoiceQueries.updateTuitionInvoicePayment,
      [invoiceId, amountPaid, datePaid, status]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition invoice not found" 
      });
    }

    logger.info(`Tuition invoice payment updated: ${invoiceId} - $${amountPaid}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error updating tuition invoice payment" 
    });
  }
};

// DELETE /api/tuition-invoices/:invoiceId
const deleteTuitionInvoice = async (req, res) => {
  const { invoiceId } = req.params;

  if (!invoiceId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing invoiceId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionInvoiceQueries.deleteTuitionInvoiceById, [invoiceId]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition invoice not found" 
      });
    }

    logger.info(`Tuition invoice deleted: ${invoiceId}`);
    return res.status(200).json({ 
      status: "success", 
      message: "Tuition invoice deleted" 
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error deleting tuition invoice" 
    });
  }
};

// POST /api/tuition-invoices/generate
const generateInvoices = async (req, res) => {
  const { school, grade, billingMonth, dueDate } = req.body;

  if (!school || !billingMonth || !dueDate) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: school, billingMonth, dueDate" 
    });
  }

  try {
    // Parse billing month to get period start and end
    const billingDate = new Date(billingMonth + '-01');
    const periodStart = billingDate.toISOString().split('T')[0];
    const periodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0)
      .toISOString().split('T')[0];

    // Get active tuition plans for school/grade
    const { rows: plans } = await db.query(
      tuitionInvoiceQueries.selectActiveTuitionPlansBySchoolAndGrade, 
      [school, grade || null]
    );

    if (plans.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "No active tuition plans found for the specified criteria" 
      });
    }

    // Get students for school/grade
    const { rows: students } = await db.query(
      tuitionInvoiceQueries.selectStudentsBySchoolAndGrade, 
      [school, grade || null]
    );

    if (students.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "No students found for the specified criteria" 
      });
    }

    let invoicesCreated = 0;
    let invoicesSkipped = 0;
    const errors = [];

    // Generate invoices for each student
    for (const student of students) {
      // Find tuition plan for student's grade
      const plan = plans.find(p => p.grade === student.grade);
      
      if (!plan) {
        errors.push(`No tuition plan found for ${student.student_name} (Grade ${student.grade})`);
        continue;
      }

      // Only generate monthly invoices
      if (plan.frequency !== 'Monthly') {
        continue;
      }

      try {
        // Check if invoice already exists for this period
        const { rows: existingInvoice } = await db.query(
          tuitionInvoiceQueries.checkInvoiceExists,
          [student.student_id, plan.plan_id, periodStart, periodEnd]
        );

        if (existingInvoice.length > 0) {
          invoicesSkipped++;
          continue;
        }

        // Determine primary parent (prefer mother, fallback to father)
        let parentName = student.mother_name;
        let parentEmail = student.mother_email;
        let parentNumber = student.mother_number;

        if (!parentName && student.father_name) {
          parentName = student.father_name;
          parentEmail = student.father_email;
          parentNumber = student.father_number;
        }

        // Create invoice
        await db.query(
          tuitionInvoiceQueries.insertTuitionInvoice,
          [
            plan.plan_id,
            student.student_id,
            student.student_name,
            student.grade,
            null, // parent_id (we don't have it in students table)
            parentName,
            parentEmail,
            parentNumber,
            periodStart,
            periodEnd,
            plan.amount,
            dueDate,
            null, // amount_paid
            null, // date_paid
            new Date().toISOString().split('T')[0], // issued_at
            'pending',
            school
          ]
        );

        invoicesCreated++;
      } catch (error) {
        errors.push(`Error creating invoice for ${student.student_name}: ${error.message}`);
      }
    }

    logger.info(`Bulk invoice generation completed: ${invoicesCreated} created, ${invoicesSkipped} skipped for ${school}`);
    
    return res.status(200).json({ 
      status: "success", 
      data: {
        invoicesCreated,
        invoicesSkipped,
        totalStudents: students.length,
        errors: errors.length > 0 ? errors : undefined
      },
      message: `Generated ${invoicesCreated} invoices successfully`
    });

  } catch (error) {
    logger.error({
      error: error,
      message: error.message,
      stack: error.stack,
      body: req.body,
      function: 'generateInvoices'
    }, 'Error generating invoices');
    return res.status(500).json({ 
      status: "failed", 
      message: "Error generating invoices" 
    });
  }
};

module.exports = {
  getTuitionInvoicesBySchool,
  getTuitionInvoiceById,
  getTuitionInvoicesByStudentId,
  getTuitionInvoicesByParentId,
  getTuitionInvoicesByStatusAndSchool,
  getOverdueTuitionInvoicesBySchool,
  createTuitionInvoice,
  updateTuitionInvoice,
  updateTuitionInvoicePayment,
  deleteTuitionInvoice,
  generateInvoices
};