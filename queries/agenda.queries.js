// src/queries/agenda.queries.js

const agendaQueries = {
  /**
   * Get all agendas for a school
   * Params: school (public.school enum)
   */
  selectAgendasBySchool: `
    SELECT
      a.agenda_id,
      a.school,
      a.school_id,
      a.academic_year,
      a.title,
      a.start_month,
      a.end_month,
      a.footer_text,
      a.include_notes_page,
      a.evaluation_subjects,
      a.theme,
      a.status,
      a.generated_file_path,
      a.generated_page_count,
      a.generated_at,
      a.generation_error,
      a.created_at,
      a.updated_at
    FROM agendas a
    WHERE a.school = $1
    ORDER BY a.academic_year DESC
  `,

  /**
   * Get a single agenda by ID
   * Params: agenda_id (UUID)
   */
  selectAgendaById: `
    SELECT
      a.agenda_id,
      a.school,
      a.school_id,
      a.academic_year,
      a.title,
      a.start_month,
      a.end_month,
      a.footer_text,
      a.include_notes_page,
      a.evaluation_subjects,
      a.theme,
      a.status,
      a.generated_file_path,
      a.generated_page_count,
      a.generated_at,
      a.generation_error,
      a.created_at,
      a.updated_at
    FROM agendas a
    WHERE a.agenda_id = $1
  `,

  /**
   * Create new agenda
   * Params: school, school_id, academic_year, title, footer_text
   */
  insertAgenda: `
    INSERT INTO agendas (
      school,
      school_id,
      academic_year,
      title,
      footer_text,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING *
  `,

  /**
   * Update agenda settings
   * Params: title, footer_text, include_notes_page, evaluation_subjects (jsonb), theme (jsonb), agenda_id
   */
  updateAgenda: `
    UPDATE agendas
    SET
      title = $1,
      footer_text = $2,
      include_notes_page = $3,
      evaluation_subjects = $4,
      theme = $5,
      updated_at = NOW()
    WHERE agenda_id = $6
    RETURNING *
  `,

  /**
   * Delete agenda (cascades to months and custom pages)
   * Params: agenda_id (UUID)
   */
  deleteAgenda: `
    DELETE FROM agendas
    WHERE agenda_id = $1
    RETURNING *
  `,

  /**
   * Mark agenda as generating (guards against concurrent generation)
   * Params: agenda_id (UUID)
   */
  markAgendaGenerating: `
    UPDATE agendas
    SET
      status = 'generating',
      generation_error = NULL,
      updated_at = NOW()
    WHERE agenda_id = $1
      AND status <> 'generating'
    RETURNING *
  `,

  /**
   * Mark agenda generation success
   * Params: generated_file_path, generated_page_count, agenda_id
   */
  markAgendaGenerated: `
    UPDATE agendas
    SET
      status = 'generated',
      generated_file_path = $1,
      generated_page_count = $2,
      generated_at = NOW(),
      generation_error = NULL
    WHERE agenda_id = $3
    RETURNING *
  `,

  /**
   * Mark agenda generation failure
   * Params: generation_error, agenda_id
   */
  markAgendaFailed: `
    UPDATE agendas
    SET
      status = 'failed',
      generation_error = $1
    WHERE agenda_id = $2
    RETURNING *
  `,

  /**
   * Get month configs for an agenda
   * Params: agenda_id (UUID)
   */
  selectAgendaMonths: `
    SELECT
      m.agenda_month_id,
      m.agenda_id,
      m.month,
      m.quotes,
      m.updated_at
    FROM agenda_months m
    WHERE m.agenda_id = $1
    ORDER BY m.month ASC
  `,

  /**
   * Seed a month config row
   * Params: agenda_id, month
   */
  insertAgendaMonth: `
    INSERT INTO agenda_months (agenda_id, month)
    VALUES ($1, $2)
    ON CONFLICT (agenda_id, month) DO NOTHING
    RETURNING *
  `,

  /**
   * Update a month's quotes
   * Params: quotes (jsonb), agenda_id, month
   */
  updateAgendaMonth: `
    UPDATE agenda_months
    SET
      quotes = $1,
      updated_at = NOW()
    WHERE agenda_id = $2 AND month = $3
    RETURNING *
  `,

  /**
   * Get custom pages for an agenda in book order
   * Params: agenda_id (UUID)
   */
  selectCustomPages: `
    SELECT
      p.page_id,
      p.agenda_id,
      p.anchor,
      p.anchor_month,
      p.sort_order,
      p.title,
      p.file_path,
      p.file_type,
      p.mime_type,
      p.page_count,
      p.fit_mode,
      p.zoom,
      p.zoom_y,
      p.offset_x,
      p.offset_y,
      p.created_at
    FROM agenda_custom_pages p
    WHERE p.agenda_id = $1
    ORDER BY
      CASE p.anchor WHEN 'intro' THEN 0 WHEN 'month' THEN 1 ELSE 2 END,
      p.anchor_month NULLS FIRST,
      p.sort_order ASC,
      p.created_at ASC
  `,

  /**
   * Get a single custom page
   * Params: page_id (UUID)
   */
  selectCustomPageById: `
    SELECT
      p.page_id,
      p.agenda_id,
      p.anchor,
      p.anchor_month,
      p.sort_order,
      p.title,
      p.file_path,
      p.file_type,
      p.mime_type,
      p.page_count,
      p.fit_mode,
      p.zoom,
      p.zoom_y,
      p.offset_x,
      p.offset_y,
      p.created_at
    FROM agenda_custom_pages p
    WHERE p.page_id = $1
  `,

  /**
   * Next sort_order within an anchor slot
   * Params: agenda_id, anchor, anchor_month (nullable)
   */
  selectNextSortOrder: `
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM agenda_custom_pages
    WHERE agenda_id = $1
      AND anchor = $2
      AND (anchor_month = $3 OR ($3::smallint IS NULL AND anchor_month IS NULL))
  `,

  /**
   * Insert custom page
   * Params: agenda_id, anchor, anchor_month, sort_order, title, file_path, file_type,
   *         mime_type, page_count, fit_mode, zoom, zoom_y, offset_x, offset_y
   */
  insertCustomPage: `
    INSERT INTO agenda_custom_pages (
      agenda_id,
      anchor,
      anchor_month,
      sort_order,
      title,
      file_path,
      file_type,
      mime_type,
      page_count,
      fit_mode,
      zoom,
      zoom_y,
      offset_x,
      offset_y
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `,

  /**
   * Move/reorder a custom page
   * Params: anchor, anchor_month, sort_order, page_id
   */
  updateCustomPagePlacement: `
    UPDATE agenda_custom_pages
    SET
      anchor = $1,
      anchor_month = $2,
      sort_order = $3
    WHERE page_id = $4
    RETURNING *
  `,

  /**
   * Update a custom page's settings
   * Params: title, fit_mode, zoom, zoom_y, offset_x, offset_y, page_id
   */
  updateCustomPageSettings: `
    UPDATE agenda_custom_pages
    SET
      title = $1,
      fit_mode = $2,
      zoom = $3,
      zoom_y = $4,
      offset_x = $5,
      offset_y = $6
    WHERE page_id = $7
    RETURNING *
  `,

  /**
   * Delete custom page
   * Params: page_id (UUID)
   */
  deleteCustomPage: `
    DELETE FROM agenda_custom_pages
    WHERE page_id = $1
    RETURNING *
  `,

  /**
   * Copy month configs to a new agenda (clone-forward)
   * Params: target_agenda_id, source_agenda_id
   */
  copyAgendaMonths: `
    INSERT INTO agenda_months (agenda_id, month, quotes)
    SELECT $1, month, quotes
    FROM agenda_months
    WHERE agenda_id = $2
    ON CONFLICT (agenda_id, month) DO UPDATE SET quotes = EXCLUDED.quotes
    RETURNING *
  `,

  /**
   * Touch agenda updated_at (structure changed — staleness tracking)
   * Params: agenda_id
   */
  touchAgenda: `
    UPDATE agendas
    SET updated_at = NOW()
    WHERE agenda_id = $1
  `
};

module.exports = agendaQueries;
