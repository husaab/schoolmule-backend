// controllers/finance.controller.js
//
// HTTP surface for Finance → Tuition: the QuickBooks connection, the sync
// outbox, the month grid and the family detail. Everything here is admin-only
// (routes/finance.routes.js) except the OAuth callback, which Intuit calls
// with no JWT and which recovers the school from the signed state.
//
// No request path ever calls QuickBooks; only the worker does. The one
// exception is the callback's company-name lookup right after consent.

const ExcelJS = require('exceljs');
const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/finance.queries');
const schoolYearQueries = require('../queries/schoolYear.queries');
const qboAuth = require('../services/finance/qboAuth');
const { createClient } = require('../services/finance/qboClient');
const { assembleGrid, buildLinkIndex, monthWindow, toLedgerInvoice, toLedgerApplication, toLedgerPayment } = require('../services/finance/gridAssembly');
const { loadFamilyYear, toStudent, toContact } = require('../services/finance/familyShape');
const { buildFamilyLedger, monthKeys } = require('../services/finance/ledger');
const { resolveSettings } = require('../services/finance/classify');
const { num, dateStr, groupBy } = require('../services/finance/util');
const { suggestForCustomers } = require('../services/finance/suggestions');
const oauthState = require('../utils/oauthState');

const RETURN_PATHS = ['/finance/tuition'];
const safeReturnTo = (path) => (RETURN_PATHS.includes(path) ? path : RETURN_PATHS[0]);
const torontoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

// Every QuickBooks state carries this purpose and the callback insists on it,
// so a state minted by the Google Sheets flow can never finish this callback.
const STATE_PURPOSE = 'qbo';
const signState = (payload) => oauthState.signState({ ...payload, purpose: STATE_PURPOSE });
const verifyState = (state) => oauthState.verifyState(state, { purpose: STATE_PURPOSE });

const fail = (res, status, message) => res.status(status).json({ status: 'failed', message });
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

// ─── Shaping ──────────────────────────────────────────────────────────

// The refresh/access tokens never leave the server.
const toConnection = (row) => (row ? {
  connected: row.status !== 'disconnected',
  status: row.status,
  realmId: row.realm_id,
  companyName: row.company_name,
  settings: row.settings || {},
  cdcCursor: row.cdc_cursor,
  backfillCompletedAt: row.backfill_completed_at,
  lastSuccessAt: row.last_success_at,
  lastError: row.last_error,
  consecutiveFailures: row.consecutive_failures,
  connectedBy: row.connected_by,
  connectedAt: row.connected_at,
} : { connected: false, status: null, realmId: null, companyName: null, settings: {}, cdcCursor: null, backfillCompletedAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, connectedBy: null, connectedAt: null });

const toJob = (row) => (row ? { jobId: row.job_id, kind: row.kind, state: row.state, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, createdAt: row.created_at } : null);

const toRun = (row) => (row ? {
  runId: row.run_id, jobId: row.job_id, kind: row.kind, mode: row.mode, status: row.status,
  startedAt: row.started_at, finishedAt: row.finished_at, cursorFrom: row.cursor_from, cursorTo: row.cursor_to,
  customersUpserted: row.customers_upserted, invoicesUpserted: row.invoices_upserted, paymentsUpserted: row.payments_upserted,
  deletedFlagged: row.deleted_flagged, apiCalls: row.api_calls, error: row.error, triggeredBy: row.triggered_by,
} : null);

const toFamily = (row) => ({
  familyId: row.family_id, schoolYearId: row.school_year_id, name: row.name, isSubsidy: Boolean(row.is_subsidy), isTeacher: Boolean(row.is_teacher),
  expectedMonthlyParent: num(row.expected_monthly_parent), expectedMonthlySubsidy: num(row.expected_monthly_subsidy),
  notes: row.notes ?? null, rosterFamilyNo: row.roster_family_no ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
});

async function loadYear(req) {
  if (!req.schoolYear) return null;
  const { rows } = await db.query(schoolYearQueries.selectYearById, [req.schoolYear.schoolYearId]);
  return rows[0] || null;
}

// Successful jobs are deleted, failed ones linger. A failed job older than the
// last success is history, not the current state.
const currentJob = (job, conn) => {
  if (!job) return null;
  if (job.state === 'failed' && conn?.last_success_at && new Date(job.created_at) < new Date(conn.last_success_at)) return null;
  return job;
};

async function loadSyncState(school) {
  const [{ rows: conn }, { rows: jobs }] = await Promise.all([
    db.query(queries.selectConnection, [school]),
    db.query(queries.selectLatestJob, [school]),
  ]);
  const row = conn[0] || null;
  const job = currentJob(jobs[0] || null, row);
  return {
    row,
    job,
    shaped: row ? {
      connected: row.status !== 'disconnected', status: row.status, last_success_at: row.last_success_at,
      last_error: row.last_error, cdc_cursor: row.cdc_cursor, pending: Boolean(job && job.state !== 'failed'),
    } : null,
  };
}

// ─── Connection ───────────────────────────────────────────────────────

const getConnection = async (req, res) => {
  try {
    const { rows } = await db.query(queries.selectConnection, [req.user.school]);
    return ok(res, toConnection(rows[0]));
  } catch (error) {
    logger.error({ err: error }, 'Error loading QuickBooks connection');
    return fail(res, 500, 'Error loading QuickBooks connection');
  }
};

/** JSON rather than a redirect, so the school can be baked into the signed state. */
const getConnectUrl = async (req, res) => {
  try {
    const url = qboAuth.buildAuthUrl({
      state: signState({ school: req.user.school, userId: req.user.userId, returnTo: safeReturnTo(req.query.returnTo), iat: Date.now() }),
    });
    return ok(res, { url });
  } catch (error) {
    // The message names env vars; keep that in the log, not the response.
    logger.error({ err: error }, 'Error building QuickBooks auth URL');
    return fail(res, 500, 'QuickBooks connection is not configured on the server');
  }
};

/**
 * Intuit's callback. Unauthenticated by necessity; the school comes from the
 * HMAC-signed state, never from a query parameter.
 */
const oauthCallback = async (req, res) => {
  const appUrl = process.env.FRONTEND_URL || '';
  const state = verifyState(req.query.state);
  const back = (code) => res.redirect(`${appUrl}${safeReturnTo(state?.returnTo)}?qbo=${code}`);
  let tokens = null;

  try {
    if (req.query.error) return back('denied');
    if (!state) return back('invalid_state');
    if (!req.query.code) return back('missing_code');
    const realmId = String(req.query.realmId || '');
    if (!/^\d+$/.test(realmId)) return back('error');

    // The state proves who started the flow; the database proves they still may finish it.
    const { rows: users } = await db.query(queries.selectUserForOAuth, [state.userId]);
    const actor = users[0];
    if (!actor || actor.role !== 'ADMIN' || actor.school !== state.school || actor.is_archived) {
      logger.warn({ school: state.school, userId: state.userId }, 'QuickBooks connect refused: not an active admin of the school');
      return back('forbidden');
    }

    tokens = await qboAuth.exchangeCode(req.query.code);

    let companyName = null;
    try {
      const client = createClient({ school: state.school, realmId, getToken: async () => tokens.accessToken });
      const info = await client.request('GET', `companyinfo/${realmId}`);
      companyName = info?.CompanyInfo?.CompanyName || null;
    } catch (error) {
      logger.warn({ school: state.school, err: error.message }, 'Could not read QuickBooks company name');
    }

    // A school's cache belongs to one realm. Switching realms needs an explicit purge first.
    const { rows: existing } = await db.query(queries.selectConnection, [state.school]);
    if (existing[0] && existing[0].realm_id !== realmId) {
      // Don't leave a live grant we will never use.
      await qboAuth.revokeToken(tokens.refreshToken, { school: state.school });
      return back('realm_conflict');
    }

    await qboAuth.saveConnection({ school: state.school, realmId, companyName, tokens, userId: state.userId });
    await db.query(queries.enqueueJob, [state.school, 'backfill', state.userId]);

    logger.info({ school: state.school, realmId, companyName }, 'QuickBooks connected');
    return back('connected');
  } catch (error) {
    if (error?.code === '23505') {
      // The realm already belongs to another school; drop the grant we just received.
      await qboAuth.revokeToken(tokens?.refreshToken, { school: state.school });
      return back('realm_conflict');
    }
    logger.error({ err: error }, 'QuickBooks OAuth callback failed');
    return back('error');
  }
};

const disconnect = async (req, res) => {
  try {
    const purge = String(req.query.purge) === 'true';
    await qboAuth.disconnect(req.user.school, { revoke: true });
    if (purge) await db.query(queries.deleteConnection, [req.user.school]);
    logger.info({ school: req.user.school, purge }, 'QuickBooks disconnected');
    return ok(res, { disconnected: true, purged: purge });
  } catch (error) {
    logger.error({ err: error }, 'Error disconnecting QuickBooks');
    return fail(res, 500, 'Error disconnecting QuickBooks');
  }
};

// ─── Sync ─────────────────────────────────────────────────────────────

const syncNow = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows: conn } = await db.query(queries.selectConnection, [school]);
    if (!conn[0] || conn[0].status !== 'active') {
      return fail(res, 409, conn[0]?.status === 'needs_reconnect' ? 'QuickBooks needs to be reconnected' : 'QuickBooks is not connected');
    }
    const { rows: recent } = await db.query(queries.selectRecentManualRun, [school]);
    if (recent.length > 0) return fail(res, 429, 'A sync was started less than a minute ago; please wait');

    const { rows } = await db.query(queries.enqueueJob, [school, 'manual', req.user.userId]);
    if (rows[0]) return ok(res, { jobId: rows[0].job_id, alreadyQueued: false }, 202);

    const { rows: live } = await db.query(queries.selectLatestJob, [school]);
    return ok(res, { jobId: live[0]?.job_id ?? null, alreadyQueued: true }, 202);
  } catch (error) {
    logger.error({ err: error }, 'Error queuing QuickBooks sync');
    return fail(res, 500, 'Error queuing QuickBooks sync');
  }
};

const getSyncStatus = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows: conn } = await db.query(queries.selectConnection, [school]);
    const { rows: jobs } = await db.query(queries.selectLatestJob, [school]);
    const { rows: runs } = await db.query(queries.selectLastRun, [school]);
    const job = currentJob(jobs[0] || null, conn[0]);
    return ok(res, {
      connection: toConnection(conn[0]),
      job: toJob(job),
      lastRun: toRun(runs[0]),
      pendingSync: Boolean(job && job.state !== 'failed'),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading QuickBooks sync status');
    return fail(res, 500, 'Error loading sync status');
  }
};

const listRuns = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await db.query(queries.selectRecentRuns, [req.user.school, limit, offset]);
    const { rows: count } = await db.query(queries.countRuns, [req.user.school]);
    return ok(res, { runs: rows.map(toRun), total: count[0]?.total ?? rows.length, limit, offset });
  } catch (error) {
    logger.error({ err: error }, 'Error listing QuickBooks sync runs');
    return fail(res, 500, 'Error listing sync runs');
  }
};

// ─── Grid ─────────────────────────────────────────────────────────────

/** Everything the grid, the CSV and the anomalies view are computed from. */
async function loadGridData(req) {
  const school = req.user.school;
  const year = await loadYear(req);
  if (!year) return null;
  const yearId = year.school_year_id;
  const { from, to } = monthWindow(year);

  const { row: connRow, shaped: sync } = await loadSyncState(school);
  const settings = resolveSettings(connRow?.settings || {});

  const [{ families, students, contacts, links }, customers, invoices, missing] = await Promise.all([
    loadFamilyYear(db, school, yearId),
    db.query(queries.selectCustomerSummaries, [school]).then((r) => r.rows),
    db.query(queries.selectInvoicesInWindow, [school, from, to]).then((r) => r.rows),
    db.query(queries.countStudentsWithoutFamily, [school, yearId]).then((r) => r.rows),
  ]);

  const invoiceIds = invoices.map((i) => i.qbo_id);
  const customerIds = [...new Set(links.map((l) => l.qbo_customer_id))];
  const [lines, applications, payments] = await Promise.all([
    invoiceIds.length ? db.query(queries.selectInvoiceLinesForInvoices, [school, invoiceIds]) : { rows: [] },
    invoiceIds.length ? db.query(queries.selectApplicationsForInvoices, [school, invoiceIds]) : { rows: [] },
    customerIds.length ? db.query(queries.selectPaymentsForCustomers, [school, customerIds]) : { rows: [] },
  ].map((p) => Promise.resolve(p).then((r) => r.rows)));

  const grid = assembleGrid({
    year, today: torontoToday(), settings,
    families, students, contacts, links, customers, invoices, lines, applications, payments,
    studentsWithoutFamily: missing[0]?.count ?? 0,
    sync,
  });
  return { grid, year, yearId, school, rows: { families, students, contacts, links, customers, invoices } };
}

const getGrid = async (req, res) => {
  try {
    const data = await loadGridData(req);
    if (!data) return fail(res, 400, 'No school year configured for your school');
    return ok(res, data.grid);
  } catch (error) {
    logger.error({ err: error }, 'Error building tuition grid');
    return fail(res, 500, 'Error building tuition grid');
  }
};

// A cell starting with =, +, -, @, tab or CR is executed as a formula by
// Excel/Sheets. Names come from QuickBooks and parents, so neutralize them.
const csvText = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

/** One row per family: identity, one status + owed pair per month, then YTD totals. */
const exportGridCsv = async (req, res) => {
  try {
    const data = await loadGridData(req);
    if (!data) return fail(res, 400, 'No school year configured for your school');
    const { grid, year } = data;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tuition');
    ws.columns = [
      { header: 'Family', key: 'family' }, { header: 'Students', key: 'students' }, { header: 'Primary contact', key: 'contact' },
      { header: 'Customer', key: 'customer' }, { header: 'Subsidy', key: 'subsidy' }, { header: 'Teacher', key: 'teacher' },
      ...grid.months.flatMap((m) => [{ header: `${m} status`, key: `${m}-status` }, { header: `${m} owed`, key: `${m}-owed` }]),
      { header: 'Invoiced YTD', key: 'invoiced' }, { header: 'Paid YTD', key: 'paid' }, { header: 'Balance', key: 'balance' },
    ];
    for (const f of grid.families) {
      const primary = f.contacts.find((c) => c.isPrimary) || f.contacts[0];
      const row = {
        family: csvText(f.name),
        students: csvText(f.students.map((s) => `${s.name} (${s.grade})`).join('; ')),
        contact: csvText(primary?.email || primary?.name || ''),
        customer: csvText(f.customer?.displayName || ''),
        subsidy: f.isSubsidy ? 'yes' : 'no',
        teacher: f.isTeacher ? 'yes' : 'no',
        invoiced: f.parent.totals.invoiced, paid: f.parent.totals.paid, balance: f.parent.totals.balance,
      };
      for (const m of grid.months) {
        const cell = f.parent.cells[m];
        row[`${m}-status`] = cell.status;
        row[`${m}-owed`] = cell.balance;
      }
      ws.addRow(row);
    }
    const buffer = await wb.csv.writeBuffer();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tuition-${year.label}.csv"`);
    return res.send(buffer);
  } catch (error) {
    logger.error({ err: error }, 'Error exporting tuition CSV');
    return fail(res, 500, 'Error exporting tuition CSV');
  }
};

/** What the admin still has to sort out: unlinked money, orphan students, odd invoices, dead links, warnings. */
const getAnomalies = async (req, res) => {
  try {
    const data = await loadGridData(req);
    if (!data) return fail(res, 400, 'No school year configured for your school');
    const { grid, school, yearId, rows } = data;

    const customerById = new Map(rows.customers.map((c) => [c.qbo_id, c]));
    const familyById = new Map(grid.families.map((f) => [f.familyId, f]));
    const linkIndex = buildLinkIndex(rows.links);
    const suggestionFamilies = grid.families.map((f) => ({ family_id: f.familyId, name: f.name, contacts: f.contacts, students: f.students }));

    const unlinkedRows = grid.unlinked.customers.map((u) => customerById.get(u.qboId) || { qbo_id: u.qboId, display_name: u.displayName, emails: [], active: true });
    const unlinkedCustomers = suggestForCustomers(unlinkedRows, suggestionFamilies).map((c) => {
      const u = grid.unlinked.customers.find((x) => x.qboId === c.qboId);
      return { ...c, invoiceCount: u.invoiceCount, invoiceTotal: u.invoiceTotal, openBalance: u.openBalance, earliestInvoiceDate: u.earliestInvoiceDate };
    });

    const { rows: orphans } = await db.query(queries.selectStudentsWithoutFamily, [school, yearId]);

    const otherKindInvoices = rows.invoices
      .filter((i) => i.kind === 'other' && !i.deleted_at && !i.is_voided)
      .map((i) => {
        const familyId = linkIndex.familyFor(i.customer_qbo_id, dateStr(i.txn_date));
        return {
          qboId: i.qbo_id, docNumber: i.doc_number ?? null, txnDate: dateStr(i.txn_date), total: num(i.total_amt), balance: num(i.balance),
          customerQboId: i.customer_qbo_id, customerName: customerById.get(i.customer_qbo_id)?.display_name ?? null,
          familyId, familyName: familyId ? familyById.get(familyId)?.name ?? null : null,
        };
      });

    const staleLinks = grid.families.flatMap((f) => {
      if (!f.customer) return [];
      const c = customerById.get(f.customer.qboId);
      const reason = !c ? 'missing' : c.deleted_at ? 'deleted' : c.active === false ? 'inactive' : null;
      return reason ? [{ familyId: f.familyId, familyName: f.name, qboCustomerId: f.customer.qboId, customerName: c?.display_name ?? null, reason }] : [];
    });

    const warningsByFamily = grid.families.filter((f) => f.warnings.length > 0).map((f) => ({ familyId: f.familyId, name: f.name, warnings: f.warnings }));

    return ok(res, {
      unlinkedCustomers,
      studentsWithoutFamily: orphans.map((s) => ({ studentId: s.student_id, name: s.name, grade: s.grade })),
      otherKindInvoices,
      staleLinks,
      warningsByFamily,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error building anomalies');
    return fail(res, 500, 'Error building anomalies');
  }
};

// ─── Family detail ────────────────────────────────────────────────────

const getFamily = async (req, res) => {
  try {
    const school = req.user.school;
    const { rows: fam } = await db.query(queries.selectFamilyById, [school, req.params.familyId]);
    const family = fam[0];
    if (!family) return fail(res, 404, 'Family not found');

    const { rows: yearRows } = await db.query(schoolYearQueries.selectYearById, [family.school_year_id]);
    const year = yearRows[0];
    const months = year ? monthKeys(dateStr(year.start_date), dateStr(year.end_date)) : [];
    const { rows: conn } = await db.query(queries.selectConnection, [school]);
    const settings = resolveSettings(conn[0]?.settings || {});

    const [students, contacts, links, audit] = await Promise.all([
      db.query(queries.selectFamilyStudents, [family.family_id]),
      db.query(queries.selectFamilyContacts, [family.family_id]),
      db.query(queries.selectFamilyLinks, [school, family.family_id]),
      db.query(queries.selectAuditForFamily, [school, family.family_id, 20]),
    ].map((p) => p.then((r) => r.rows)));

    const customerIds = [...new Set(links.map((l) => l.qbo_customer_id))];
    const linkIndex = buildLinkIndex(links);
    const allInvoices = customerIds.length ? (await db.query(queries.selectInvoicesForCustomers, [school, customerIds])).rows : [];
    // Only invoices dated inside a link's range belong to this family.
    const invoices = allInvoices.filter((i) => linkIndex.familyFor(i.customer_qbo_id, dateStr(i.txn_date)) === family.family_id);
    const invoiceIds = invoices.map((i) => i.qbo_id);
    const [lines, applications, payments] = await Promise.all([
      invoiceIds.length ? db.query(queries.selectInvoiceLinesForInvoices, [school, invoiceIds]) : { rows: [] },
      invoiceIds.length ? db.query(queries.selectApplicationsForInvoices, [school, invoiceIds]) : { rows: [] },
      customerIds.length ? db.query(queries.selectPaymentsForCustomers, [school, customerIds]) : { rows: [] },
    ].map((p) => Promise.resolve(p).then((r) => r.rows)));

    const linesByInvoice = groupBy(lines, 'invoice_qbo_id');
    const appsByInvoice = groupBy(applications, 'invoice_qbo_id');

    const activeStudents = students.filter((s) => !s.is_archived).length;
    const expectedParent = num(family.expected_monthly_parent);
    const ledger = months.length ? buildFamilyLedger({
      months, today: torontoToday(),
      invoices: invoices.map((r) => toLedgerInvoice(r, linesByInvoice)),
      applications: applications.map(toLedgerApplication),
      payments: payments.map(toLedgerPayment),
      items: settings.items,
      expected: expectedParent === null ? undefined : { monthlyParent: expectedParent },
    }) : null;

    const current = linkIndex.currentFor(family.family_id);

    return ok(res, {
      family: toFamily(family),
      months,
      students: students.map(toStudent),
      contacts: contacts.map(toContact),
      customerLinks: links.map((l) => ({
        linkId: l.link_id, qboCustomerId: l.qbo_customer_id, customerName: l.customer_name || null, isSubCustomer: Boolean(l.is_sub_customer),
        customerActive: l.customer_active !== false, effectiveFrom: dateStr(l.effective_from), effectiveTo: dateStr(l.effective_to),
        current: l.effective_to === null, createdAt: l.created_at,
      })),
      customer: current ? { qboId: current.customerId, displayName: links.find((l) => l.link_id === current.linkId)?.customer_name || null } : null,
      ledger,
      invoices: invoices.map((i) => ({
        qboId: i.qbo_id, docNumber: i.doc_number ?? null, txnDate: dateStr(i.txn_date), month: dateStr(i.txn_date).slice(0, 7), dueDate: dateStr(i.due_date),
        total: num(i.total_amt), balance: num(i.balance), kind: i.kind, kindAuto: i.kind_auto, kindOverride: i.kind_override ?? null,
        isVoided: Boolean(i.is_voided), deleted: Boolean(i.deleted_at), emailStatus: i.email_status, privateNote: i.private_note ?? null,
        customerQboId: i.customer_qbo_id, isRecurring: Boolean(i.recurring_ref),
        lines: (linesByInvoice.get(i.qbo_id) || []).map((l) => ({ lineNum: l.line_num, description: l.description, amount: num(l.amount), itemRef: l.item_ref, itemName: l.item_name, studentHint: l.student_hint })),
        payments: (appsByInvoice.get(i.qbo_id) || []).map((a) => ({ paymentId: a.payment_qbo_id, amount: num(a.amount), date: dateStr(a.payment_date), ref: a.payment_ref_num ?? null, method: a.payment_method ?? null, deleted: Boolean(a.payment_deleted) })),
      })),
      payments: payments.map((p) => ({ paymentId: p.qbo_id, customerQboId: p.customer_qbo_id, date: dateStr(p.txn_date), total: num(p.total_amt), unapplied: num(p.unapplied_amt), ref: p.payment_ref_num ?? null, method: p.payment_method ?? null, deleted: Boolean(p.deleted_at) })),
      audit: audit.map((a) => ({
        auditId: a.audit_id, action: a.action, oldQboCustomerId: a.old_qbo_customer_id, newQboCustomerId: a.new_qbo_customer_id, studentId: a.student_id,
        invoiceQboId: a.invoice_qbo_id, details: a.details, actorUserId: a.actor_user_id,
        actorName: a.actor_first_name ? `${a.actor_first_name} ${a.actor_last_name || ''}`.trim() : null, createdAt: a.created_at,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading family');
    return fail(res, 500, 'Error loading family');
  }
};

module.exports = {
  getConnection, getConnectUrl, oauthCallback, disconnect,
  syncNow, getSyncStatus, listRuns,
  getGrid, exportGridCsv, getAnomalies, getFamily,
  RETURN_PATHS,
};
