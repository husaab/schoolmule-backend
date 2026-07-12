// src/controllers/agenda.controller.js

const db = require('../config/database');
const agendaQueries = require('../queries/agenda.queries');
const logger = require('../logger');
const supabase = require('../config/supabaseClient');
const multer = require('multer');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const agendaComposer = require('../services/agendaComposer');
const { assembleAgenda } = require('../services/agendaAssembler');
const { parseAcademicYear, academicMonthSequence } = require('../utils/agendaCalendar');

const AGENDA_BUCKET = 'agendas';

// Dedicated multer instance: designed PDFs (Canva exports) routinely
// exceed the 5MB school-assets limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, PNG, and JPEG are allowed.'));
    }
  }
});

const toCamelAgenda = (row) => ({
  agendaId: row.agenda_id,
  school: row.school,
  schoolId: row.school_id,
  academicYear: row.academic_year,
  title: row.title,
  startMonth: row.start_month,
  endMonth: row.end_month,
  footerText: row.footer_text,
  includeNotesPage: row.include_notes_page,
  evaluationSubjects: row.evaluation_subjects,
  status: row.status,
  generatedFilePath: row.generated_file_path,
  generatedPageCount: row.generated_page_count,
  generatedAt: row.generated_at,
  generationError: row.generation_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toCamelMonth = (row) => ({
  agendaMonthId: row.agenda_month_id,
  agendaId: row.agenda_id,
  month: row.month,
  quotes: row.quotes,
  updatedAt: row.updated_at
});

const toCamelCustomPage = (row) => ({
  pageId: row.page_id,
  agendaId: row.agenda_id,
  anchor: row.anchor,
  anchorMonth: row.anchor_month,
  sortOrder: row.sort_order,
  title: row.title,
  filePath: row.file_path,
  fileType: row.file_type,
  mimeType: row.mime_type,
  pageCount: row.page_count,
  createdAt: row.created_at
});

const schoolFolder = (school) => String(school).replace(/\s+/g, '').toUpperCase();

/** Load an agenda row or send a 404. Returns null when already handled. */
const findAgendaOr404 = async (agendaId, res) => {
  const { rows } = await db.query(agendaQueries.selectAgendaById, [agendaId]);
  if (rows.length === 0) {
    res.status(404).json({ status: 'failed', message: 'Agenda not found' });
    return null;
  }
  return rows[0];
};

/**
 * GET /api/agendas?school=SCHOOL_ENUM
 */
const getAgendasBySchool = async (req, res) => {
  const { school } = req.query;

  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'School parameter is required' });
  }

  try {
    const { rows } = await db.query(agendaQueries.selectAgendasBySchool, [school]);
    return res.status(200).json({ status: 'success', data: rows.map(toCamelAgenda) });
  } catch (error) {
    logger.error('Error fetching agendas:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching agendas' });
  }
};

/**
 * POST /api/agendas
 * Body: { school, academicYear, title?, footerText? }
 * Creates the agenda and seeds its month config rows.
 */
const createAgenda = async (req, res) => {
  const { school, academicYear, title, footerText } = req.body;

  if (!school || !academicYear) {
    return res.status(400).json({ status: 'failed', message: 'school and academicYear are required' });
  }

  try {
    parseAcademicYear(academicYear); // validates format
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: error.message });
  }

  try {
    const { rows: schoolRows } = await db.query(
      'SELECT school_id, name FROM schools WHERE school_code = $1',
      [school]
    );
    const schoolId = schoolRows[0]?.school_id || null;
    const defaultFooter = footerText || (schoolRows[0]?.name ? `${schoolRows[0].name} | ` : '');

    const { rows } = await db.query(agendaQueries.insertAgenda, [
      school,
      schoolId,
      academicYear,
      title || 'Student Agenda',
      defaultFooter
    ]);
    const agenda = rows[0];

    const monthSeq = academicMonthSequence(academicYear, agenda.start_month, agenda.end_month);
    for (const { month } of monthSeq) {
      await db.query(agendaQueries.insertAgendaMonth, [agenda.agenda_id, month]);
    }

    return res.status(201).json({ status: 'success', data: toCamelAgenda(agenda) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        status: 'failed',
        message: `An agenda for ${academicYear} already exists for this school`
      });
    }
    logger.error('Error creating agenda:', error);
    return res.status(500).json({ status: 'failed', message: 'Error creating agenda' });
  }
};

/**
 * GET /api/agendas/:agendaId
 * Full detail: agenda + month configs + custom pages. Poll target while generating.
 */
const getAgendaById = async (req, res) => {
  const { agendaId } = req.params;

  try {
    const agenda = await findAgendaOr404(agendaId, res);
    if (!agenda) return;

    const [{ rows: months }, { rows: pages }] = await Promise.all([
      db.query(agendaQueries.selectAgendaMonths, [agendaId]),
      db.query(agendaQueries.selectCustomPages, [agendaId]),
    ]);

    return res.status(200).json({
      status: 'success',
      data: {
        ...toCamelAgenda(agenda),
        months: months.map(toCamelMonth),
        customPages: pages.map(toCamelCustomPage)
      }
    });
  } catch (error) {
    logger.error('Error fetching agenda:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching agenda' });
  }
};

/**
 * PATCH /api/agendas/:agendaId
 * Body: { title?, footerText?, includeNotesPage?, evaluationSubjects? }
 */
const updateAgenda = async (req, res) => {
  const { agendaId } = req.params;
  const { title, footerText, includeNotesPage, evaluationSubjects } = req.body;

  try {
    const existing = await findAgendaOr404(agendaId, res);
    if (!existing) return;

    const { rows } = await db.query(agendaQueries.updateAgenda, [
      title ?? existing.title,
      footerText !== undefined ? footerText : existing.footer_text,
      includeNotesPage !== undefined ? includeNotesPage === true : existing.include_notes_page,
      JSON.stringify(
        evaluationSubjects !== undefined ? evaluationSubjects : existing.evaluation_subjects
      ),
      agendaId
    ]);

    return res.status(200).json({ status: 'success', data: toCamelAgenda(rows[0]) });
  } catch (error) {
    logger.error('Error updating agenda:', error);
    return res.status(500).json({ status: 'failed', message: 'Error updating agenda' });
  }
};

/**
 * DELETE /api/agendas/:agendaId
 * Removes DB rows (cascade) and the agenda's storage folder (best effort).
 */
const deleteAgenda = async (req, res) => {
  const { agendaId } = req.params;

  try {
    const agenda = await findAgendaOr404(agendaId, res);
    if (!agenda) return;

    const { rows: pages } = await db.query(agendaQueries.selectCustomPages, [agendaId]);

    await db.query(agendaQueries.deleteAgenda, [agendaId]);

    // Best-effort storage cleanup
    const storagePaths = pages.map((p) => p.file_path);
    if (agenda.generated_file_path) storagePaths.push(agenda.generated_file_path);
    if (storagePaths.length > 0) {
      const { error } = await supabase.storage.from(AGENDA_BUCKET).remove(storagePaths);
      if (error) logger.error('Agenda storage cleanup error:', error);
    }

    return res.status(200).json({ status: 'success', data: toCamelAgenda(agenda) });
  } catch (error) {
    logger.error('Error deleting agenda:', error);
    return res.status(500).json({ status: 'failed', message: 'Error deleting agenda' });
  }
};

/**
 * PATCH /api/agendas/:agendaId/months/:month
 * Body: { quotes: string[] }
 */
const updateAgendaMonth = async (req, res) => {
  const { agendaId, month } = req.params;
  const { quotes } = req.body;

  if (!Array.isArray(quotes)) {
    return res.status(400).json({ status: 'failed', message: 'quotes must be an array of strings' });
  }

  try {
    const { rows } = await db.query(agendaQueries.updateAgendaMonth, [
      JSON.stringify(quotes),
      agendaId,
      Number(month)
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Agenda month not found' });
    }

    await db.query(agendaQueries.touchAgenda, [agendaId]);

    return res.status(200).json({ status: 'success', data: toCamelMonth(rows[0]) });
  } catch (error) {
    logger.error('Error updating agenda month:', error);
    return res.status(500).json({ status: 'failed', message: 'Error updating agenda month' });
  }
};

/**
 * POST /api/agendas/:agendaId/pages
 * Multipart: file + { anchor, anchorMonth?, title? }
 * Validates PDFs with pdf-lib (detects page count, rejects encrypted files).
 */
const uploadCustomPage = async (req, res) => {
  const { agendaId } = req.params;
  const { anchor, anchorMonth, title } = req.body;
  const file = req.file;

  if (!file || !anchor) {
    return res.status(400).json({ status: 'failed', message: 'file and anchor are required' });
  }
  if (!['intro', 'month', 'closing'].includes(anchor)) {
    return res.status(400).json({ status: 'failed', message: 'anchor must be intro, month or closing' });
  }
  if (anchor === 'month' && !anchorMonth) {
    return res.status(400).json({ status: 'failed', message: 'anchorMonth is required for month anchors' });
  }

  try {
    const agenda = await findAgendaOr404(agendaId, res);
    if (!agenda) return;

    const isPdf = file.mimetype === 'application/pdf';
    let pageCount = 1;
    let sizeWarning = null;

    if (isPdf) {
      let pdfDoc;
      try {
        pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: false });
      } catch (error) {
        logger.error('Uploaded PDF failed to parse:', error);
        return res.status(400).json({
          status: 'failed',
          message: 'This PDF could not be read. Password-protected or corrupt PDFs are not supported.'
        });
      }
      pageCount = pdfDoc.getPageCount();
      if (pageCount === 0) {
        return res.status(400).json({ status: 'failed', message: 'This PDF has no pages.' });
      }
      const { width, height } = pdfDoc.getPage(0).getSize();
      // Letter is 612x792pt; flag anything more than ~2% off
      if (Math.abs(width - 612) > 15 || Math.abs(height - 792) > 15) {
        sizeWarning = `Page size is ${Math.round(width)}x${Math.round(height)}pt, not Letter (612x792). It will print at its own size.`;
      }
    }

    const extension = isPdf ? '.pdf' : (path.extname(file.originalname) || '.png');
    const { rows: sortRows } = await db.query(agendaQueries.selectNextSortOrder, [
      agendaId,
      anchor,
      anchor === 'month' ? Number(anchorMonth) : null
    ]);
    const sortOrder = sortRows[0].next_sort_order;

    // Insert first so the page_id names the storage object
    const { rows } = await db.query(agendaQueries.insertCustomPage, [
      agendaId,
      anchor,
      anchor === 'month' ? Number(anchorMonth) : null,
      sortOrder,
      title || file.originalname.replace(/\.[^.]+$/, ''),
      'pending', // placeholder, updated below
      isPdf ? 'pdf' : 'image',
      file.mimetype,
      pageCount
    ]);
    const page = rows[0];

    const filePath = `${schoolFolder(agenda.school)}/${agenda.academic_year}/custom-pages/${page.page_id}${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(AGENDA_BUCKET)
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });

    if (uploadError) {
      await db.query(agendaQueries.deleteCustomPage, [page.page_id]);
      logger.error('Supabase agenda upload error:', uploadError);
      return res.status(500).json({ status: 'failed', message: 'Upload to storage failed' });
    }

    const { rows: finalRows } = await db.query(
      'UPDATE agenda_custom_pages SET file_path = $1 WHERE page_id = $2 RETURNING *',
      [filePath, page.page_id]
    );

    await db.query(agendaQueries.touchAgenda, [agendaId]);

    return res.status(201).json({
      status: 'success',
      data: { ...toCamelCustomPage(finalRows[0]), sizeWarning }
    });
  } catch (error) {
    logger.error('Error uploading custom page:', error);
    return res.status(500).json({ status: 'failed', message: 'Error uploading custom page' });
  }
};

/**
 * PATCH /api/agendas/:agendaId/pages/reorder
 * Body: [{ pageId, anchor, anchorMonth, sortOrder }] — applied in one transaction.
 */
const reorderCustomPages = async (req, res) => {
  const { agendaId } = req.params;
  const updates = req.body;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'Body must be a non-empty array' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const update of updates) {
      const anchorMonth = update.anchor === 'month' ? Number(update.anchorMonth) : null;
      await client.query(agendaQueries.updateCustomPagePlacement, [
        update.anchor,
        anchorMonth,
        update.sortOrder,
        update.pageId
      ]);
    }
    await client.query(agendaQueries.touchAgenda, [agendaId]);
    await client.query('COMMIT');

    const { rows } = await db.query(agendaQueries.selectCustomPages, [agendaId]);
    return res.status(200).json({ status: 'success', data: rows.map(toCamelCustomPage) });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error reordering custom pages:', error);
    return res.status(500).json({ status: 'failed', message: 'Error reordering custom pages' });
  } finally {
    client.release();
  }
};

/**
 * PATCH /api/agendas/:agendaId/pages/:pageId
 * Body: { title }
 */
const updateCustomPage = async (req, res) => {
  const { agendaId, pageId } = req.params;
  const { title } = req.body;

  if (typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ status: 'failed', message: 'title is required' });
  }

  try {
    const { rows } = await db.query(agendaQueries.updateCustomPageTitle, [title.trim(), pageId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Page not found' });
    }

    await db.query(agendaQueries.touchAgenda, [agendaId]);

    return res.status(200).json({ status: 'success', data: toCamelCustomPage(rows[0]) });
  } catch (error) {
    logger.error('Error renaming custom page:', error);
    return res.status(500).json({ status: 'failed', message: 'Error renaming custom page' });
  }
};

/**
 * DELETE /api/agendas/:agendaId/pages/:pageId
 */
const deleteCustomPage = async (req, res) => {
  const { agendaId, pageId } = req.params;

  try {
    const { rows } = await db.query(agendaQueries.deleteCustomPage, [pageId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Page not found' });
    }

    const { error } = await supabase.storage.from(AGENDA_BUCKET).remove([rows[0].file_path]);
    if (error) logger.error('Agenda page storage delete error:', error);

    await db.query(agendaQueries.touchAgenda, [agendaId]);

    return res.status(200).json({ status: 'success', data: toCamelCustomPage(rows[0]) });
  } catch (error) {
    logger.error('Error deleting custom page:', error);
    return res.status(500).json({ status: 'failed', message: 'Error deleting custom page' });
  }
};

/**
 * GET /api/agendas/:agendaId/pages/:pageId/signed-url
 * Signed URL for previewing an uploaded page (1 hour).
 */
const getCustomPageSignedUrl = async (req, res) => {
  const { pageId } = req.params;

  try {
    const { rows } = await db.query(agendaQueries.selectCustomPageById, [pageId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Page not found' });
    }

    const { data, error } = await supabase.storage
      .from(AGENDA_BUCKET)
      .createSignedUrl(rows[0].file_path, 60 * 60);

    if (error) {
      logger.error('Error creating page signed URL:', error);
      return res.status(500).json({ status: 'failed', message: 'Failed to create signed URL' });
    }

    return res.status(200).json({ status: 'success', data: { signedUrl: data.signedUrl } });
  } catch (error) {
    logger.error('Error getting page signed URL:', error);
    return res.status(500).json({ status: 'failed', message: 'Error getting signed URL' });
  }
};

/**
 * GET /api/agendas/:agendaId/manifest
 * The computed page sequence with global page numbers — single source of
 * truth for both the live preview and the assembled PDF.
 */
const getAgendaManifest = async (req, res) => {
  const { agendaId } = req.params;

  try {
    const bundle = await agendaComposer.loadAgendaBundle(agendaId);
    if (!bundle) {
      return res.status(404).json({ status: 'failed', message: 'Agenda not found' });
    }

    const manifest = agendaComposer.computeSequence(bundle);
    return res.status(200).json({
      status: 'success',
      data: {
        totalPages: manifest.totalPages,
        items: manifest.items.map((item) => ({
          seq: item.seq,
          kind: item.kind,
          pageNumber: item.pageNumber,
          numbered: item.numbered,
          month: item.month,
          year: item.year,
          weekIndex: item.weekIndex,
          mondayIso: item.week?.mondayIso,
          pageId: item.pageId,
          title: item.title,
          fileType: item.fileType,
          sourcePageIndex: item.sourcePageIndex,
          sourcePageCount: item.sourcePageCount,
          anchor: item.anchor,
          anchorMonth: item.anchorMonth
        }))
      }
    });
  } catch (error) {
    logger.error('Error computing agenda manifest:', error);
    return res.status(500).json({ status: 'failed', message: 'Error computing agenda manifest' });
  }
};

/**
 * GET /api/agendas/:agendaId/render/month/:month
 * Standalone HTML documents for a month's generated pages, keyed by seq —
 * displayed by the live preview in sandboxed iframes. month=0 is not
 * valid; use ?kind=... in the future for other filters.
 */
const renderMonthPages = async (req, res) => {
  const { agendaId, month } = req.params;

  try {
    const bundle = await agendaComposer.loadAgendaBundle(agendaId);
    if (!bundle) {
      return res.status(404).json({ status: 'failed', message: 'Agenda not found' });
    }

    const manifest = agendaComposer.computeSequence(bundle);
    const monthItems = manifest.items.filter(
      (item) => item.kind !== 'custom' && item.month === Number(month)
    );

    const pages = monthItems.map((item) => ({
      seq: item.seq,
      kind: item.kind,
      pageNumber: item.pageNumber,
      html: agendaComposer.renderGeneratedPageDocument(bundle, item)
    }));

    return res.status(200).json({ status: 'success', data: pages });
  } catch (error) {
    logger.error('Error rendering agenda month:', error);
    return res.status(500).json({ status: 'failed', message: 'Error rendering agenda pages' });
  }
};

/**
 * POST /api/agendas/:agendaId/generate
 * 202 + background assembly. Concurrent generates are rejected by the
 * status-guarded UPDATE.
 */
const generateAgenda = async (req, res) => {
  const { agendaId } = req.params;

  try {
    const agenda = await findAgendaOr404(agendaId, res);
    if (!agenda) return;

    const { rows } = await db.query(agendaQueries.markAgendaGenerating, [agendaId]);
    if (rows.length === 0) {
      return res.status(409).json({
        status: 'failed',
        message: 'This agenda is already being generated'
      });
    }

    // Detached background run; status polling via GET /:agendaId
    assembleAgenda(agendaId)
      .then(async ({ filePath, pageCount }) => {
        await db.query(agendaQueries.markAgendaGenerated, [filePath, pageCount, agendaId]);
        logger.info(`Agenda ${agendaId} generated: ${pageCount} pages at ${filePath}`);
      })
      .catch(async (error) => {
        logger.error(`Agenda ${agendaId} generation failed:`, error);
        await db.query(agendaQueries.markAgendaFailed, [String(error.message || error), agendaId])
          .catch((dbError) => logger.error('Failed to record generation error:', dbError));
      });

    return res.status(202).json({ status: 'success', data: toCamelAgenda(rows[0]) });
  } catch (error) {
    logger.error('Error starting agenda generation:', error);
    return res.status(500).json({ status: 'failed', message: 'Error starting agenda generation' });
  }
};

/**
 * POST /api/agendas/:agendaId/clone
 * Body: { academicYear }
 * Clone-forward: copies settings, month quotes and custom pages (storage
 * objects copied into the new year's folder). Dated pages regenerate
 * automatically from the new academic year.
 */
const cloneAgenda = async (req, res) => {
  const { agendaId } = req.params;
  const { academicYear } = req.body;

  if (!academicYear) {
    return res.status(400).json({ status: 'failed', message: 'academicYear is required' });
  }
  try {
    parseAcademicYear(academicYear);
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: error.message });
  }

  try {
    const source = await findAgendaOr404(agendaId, res);
    if (!source) return;

    const { rows: newRows } = await db.query(agendaQueries.insertAgenda, [
      source.school,
      source.school_id,
      academicYear,
      source.title,
      source.footer_text
    ]);
    const target = newRows[0];

    // Carry over settings not covered by insertAgenda
    await db.query(agendaQueries.updateAgenda, [
      source.title,
      source.footer_text,
      source.include_notes_page,
      JSON.stringify(source.evaluation_subjects),
      target.agenda_id
    ]);

    // Seed + copy month quotes
    const monthSeq = academicMonthSequence(academicYear, source.start_month, source.end_month);
    for (const { month } of monthSeq) {
      await db.query(agendaQueries.insertAgendaMonth, [target.agenda_id, month]);
    }
    await db.query(agendaQueries.copyAgendaMonths, [target.agenda_id, agendaId]);

    // Copy custom pages: storage objects are duplicated so years stay independent
    const { rows: sourcePages } = await db.query(agendaQueries.selectCustomPages, [agendaId]);
    for (const page of sourcePages) {
      const extension = path.extname(page.file_path) || (page.file_type === 'pdf' ? '.pdf' : '.png');
      const { rows: insertedRows } = await db.query(agendaQueries.insertCustomPage, [
        target.agenda_id,
        page.anchor,
        page.anchor_month,
        page.sort_order,
        page.title,
        'pending',
        page.file_type,
        page.mime_type,
        page.page_count
      ]);
      const newPage = insertedRows[0];
      const newPath = `${schoolFolder(source.school)}/${academicYear}/custom-pages/${newPage.page_id}${extension}`;

      const { error: copyError } = await supabase.storage
        .from(AGENDA_BUCKET)
        .copy(page.file_path, newPath);
      if (copyError) {
        logger.error(`Failed to copy storage object ${page.file_path}:`, copyError);
        await db.query(agendaQueries.deleteCustomPage, [newPage.page_id]);
        continue;
      }

      await db.query(
        'UPDATE agenda_custom_pages SET file_path = $1 WHERE page_id = $2',
        [newPath, newPage.page_id]
      );
    }

    // Let the frontend prompt the admin to review the new year's calendar
    const { rows: eventCountRows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM school_calendar_events
       WHERE school = $1 AND start_date BETWEEN $2 AND $3`,
      [source.school, `${academicYear.slice(0, 4)}-08-01`, `${academicYear.slice(5, 9)}-07-31`]
    );

    return res.status(201).json({
      status: 'success',
      data: {
        ...toCamelAgenda(target),
        calendarEventCount: eventCountRows[0].count
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        status: 'failed',
        message: `An agenda for ${academicYear} already exists for this school`
      });
    }
    logger.error('Error cloning agenda:', error);
    return res.status(500).json({ status: 'failed', message: 'Error cloning agenda' });
  }
};

module.exports = {
  upload,
  getAgendasBySchool,
  createAgenda,
  getAgendaById,
  updateAgenda,
  deleteAgenda,
  updateAgendaMonth,
  uploadCustomPage,
  reorderCustomPages,
  updateCustomPage,
  deleteCustomPage,
  getCustomPageSignedUrl,
  getAgendaManifest,
  renderMonthPages,
  generateAgenda,
  cloneAgenda
};
