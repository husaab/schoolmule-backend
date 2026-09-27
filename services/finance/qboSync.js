// services/finance/qboSync.js
//
// Pulls a school's QuickBooks books into the cache tables.
//
// Two modes, chosen per run:
//   full  — every customer, every invoice since the backfill date, every
//           payment touched since then (by LastUpdatedTime, so mis-dated
//           payments are caught), then a gap pass and a sweep for deletions.
//   cdc   — Change Data Capture since the stored cursor: cheap, one call.
//           Escalates to full when the cursor is missing or older than 29
//           days (CDC's window is 30).
//
// Every write is keyed on (school, qbo_id) and guarded by LastUpdatedTime,
// so re-running any page is a no-op. Deletions are flags, never row removal.
// The cursor only advances after a successful run, and lands 5 minutes
// before the run started so a late-indexed change is never skipped.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/finance.queries');
const { createClient } = require('./qboClient');
const { getAccessToken } = require('./qboAuth');
const { resolveSettings } = require('./classify');
const { normalizeInvoice, normalizePayment, normalizeCustomer } = require('./normalize');
const { NeedsReconnectError } = require('./errors');
const alerts = require('./alerts');

const CDC_ENTITIES = ['Invoice', 'Payment', 'Customer'];
const CDC_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
const ALERT_AFTER_FAILURES = 3;
// Intuit's window filter needs a timestamp; the backfill date is a Toronto day.
const dayStartIso = (date) => `${date}T00:00:00-04:00`;

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Runs fn inside BEGIN/COMMIT on a dedicated client. */
async function inTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ─── Page writers ──────────────────────────────────────────────────────

async function writeCustomers(ctx, rawRows) {
  if (rawRows.length === 0) return 0;
  const rows = rawRows.map(normalizeCustomer);
  return inTransaction(async (client) => {
    const { rows: written } = await client.query(queries.upsertCustomers, [ctx.school, ctx.realmId, JSON.stringify(rows)]);
    return written.length;
  });
}

async function writeInvoices(ctx, rawRows) {
  if (rawRows.length === 0) return 0;
  const normalized = rawRows.map((r) => normalizeInvoice(r, ctx.settings));
  const rows = normalized.map(({ lines, ...row }) => row);
  return inTransaction(async (client) => {
    const { rows: written } = await client.query(queries.upsertInvoices, [ctx.school, ctx.realmId, JSON.stringify(rows)]);
    const ids = written.map((w) => w.qbo_id);
    if (ids.length) {
      const idSet = new Set(ids);
      const lines = normalized
        .filter((n) => idSet.has(n.qbo_id))
        .flatMap((n) => n.lines.map((l) => ({ invoice_qbo_id: n.qbo_id, ...l })));
      await client.query(queries.deleteInvoiceLines, [ctx.school, ids]);
      if (lines.length) await client.query(queries.insertInvoiceLines, [ctx.school, JSON.stringify(lines)]);
    }
    return ids.length;
  });
}

async function writePayments(ctx, rawRows) {
  if (rawRows.length === 0) return 0;
  const normalized = rawRows.map(normalizePayment);
  for (const n of normalized) {
    if (n.warnings.includes('MULTI_LINKED_LINE')) {
      logger.warn({ school: ctx.school, paymentId: n.qbo_id }, 'QBO payment line linked to several invoices; amount split evenly');
    }
  }
  const rows = normalized.map(({ applications, warnings, ...row }) => row);
  return inTransaction(async (client) => {
    const { rows: written } = await client.query(queries.upsertPayments, [ctx.school, ctx.realmId, JSON.stringify(rows)]);
    const ids = written.map((w) => w.qbo_id);
    if (ids.length) {
      const idSet = new Set(ids);
      const apps = normalized
        .filter((n) => idSet.has(n.qbo_id))
        .flatMap((n) => n.applications.map((a) => ({ payment_qbo_id: n.qbo_id, ...a })));
      await client.query(queries.deletePaymentApplications, [ctx.school, ids]);
      if (apps.length) await client.query(queries.insertPaymentApplications, [ctx.school, JSON.stringify(apps)]);
    }
    return ids.length;
  });
}

const WRITERS = { Customer: writeCustomers, Invoice: writeInvoices, Payment: writePayments };
const COUNTER = { Customer: 'customers', Invoice: 'invoices', Payment: 'payments' };

async function writeEntity(ctx, entity, rows, counts) {
  for (const page of chunk(rows, 200)) {
    counts[COUNTER[entity]] += await WRITERS[entity](ctx, page);
  }
}

async function flagDeleted(ctx, entity, ids, counts) {
  if (ids.length === 0) return;
  if (entity === 'Invoice') {
    const { rowCount } = await db.query(queries.flagInvoicesDeleted, [ctx.school, ids]);
    counts.deleted += rowCount || 0;
  } else if (entity === 'Payment') {
    const { rowCount } = await db.query(queries.flagPaymentsDeleted, [ctx.school, ids]);
    // A deleted payment's applications must go too, or the ledger keeps showing the money.
    await db.query(queries.deletePaymentApplications, [ctx.school, ids]);
    counts.deleted += rowCount || 0;
  } else if (entity === 'Customer') {
    const { rowCount } = await db.query(queries.flagCustomersDeleted, [ctx.school, ids]);
    counts.deleted += rowCount || 0;
  }
}

// ─── Modes ─────────────────────────────────────────────────────────────

async function runFull(ctx, counts, startedAt) {
  const since = ctx.settings.backfillSince;

  for await (const page of ctx.client.queryPages({ entity: 'Customer', where: [{ field: 'Active', op: 'IN', value: [true, false] }] })) {
    await writeEntity(ctx, 'Customer', page, counts);
  }
  for await (const page of ctx.client.queryPages({ entity: 'Invoice', where: [{ field: 'TxnDate', op: '>=', value: since }] })) {
    await writeEntity(ctx, 'Invoice', page, counts);
  }
  // Payments by last-updated rather than TxnDate: the bookkeeper sometimes
  // dates a payment into the wrong year, and only its links to invoices matter.
  for await (const page of ctx.client.queryPages({ entity: 'Payment', where: [{ field: 'MetaData.LastUpdatedTime', op: '>=', value: dayStartIso(since) }] })) {
    await writeEntity(ctx, 'Payment', page, counts);
  }

  // Gap pass: invoices paid by payments the window missed (created before the
  // backfill date, or applied via auto-credit) — fetch those customers' payments outright.
  const { rows: gaps } = await db.query(queries.selectCustomersWithUnexplainedPaid, [ctx.school, since]);
  for (const g of gaps) {
    for await (const page of ctx.client.queryPages({ entity: 'Payment', where: [{ field: 'CustomerRef', op: '=', value: String(g.customer_qbo_id) }] })) {
      await writeEntity(ctx, 'Payment', page, counts);
    }
  }

  // Anything in the window this run did not touch is gone from QBO.
  const { rowCount } = await db.query(queries.sweepUnseenInvoices, [ctx.school, since, startedAt]);
  counts.deleted += rowCount || 0;
}

/** @returns {boolean} true when the response was truncated and a full run is needed instead */
async function runCdc(ctx, counts, cursor) {
  const res = await ctx.client.cdc(CDC_ENTITIES, cursor.toISOString());
  if (res.truncated) {
    // CDC caps at 1000 rows per entity. A windowed re-query would miss inactive
    // customers and any deletion past the cap, so the full run (which also
    // sweeps deletions) is the only safe answer.
    logger.warn({ school: ctx.school }, 'QBO CDC response truncated; escalating to a full run');
    return true;
  }
  for (const entity of CDC_ENTITIES) {
    await writeEntity(ctx, entity, res[entity].upserts, counts);
  }
  for (const entity of CDC_ENTITIES) {
    await flagDeleted(ctx, entity, res[entity].deleted.map((d) => d.id), counts);
  }
  return false;
}

// ─── Entry point ───────────────────────────────────────────────────────

function chooseMode(kind, conn, now) {
  if (kind === 'backfill') return 'full';
  if (!conn.backfill_completed_at || !conn.cdc_cursor) return 'full';
  if (now.getTime() - new Date(conn.cdc_cursor).getTime() > CDC_MAX_AGE_MS) return 'full';
  return 'cdc';
}

/**
 * Runs one sync for a school.
 * @param {string} school
 * @param {object} [opts]
 * @param {'backfill'|'cdc'|'manual'} [opts.kind='cdc']
 * @param {string} [opts.jobId]
 * @param {string} [opts.triggeredBy]
 * @param {Function} [opts.now]         clock, for tests
 * @param {Function} [opts.makeClient]  ({school, realmId, onCall}) => client, for tests
 * @returns {Promise<{runId, mode, counts, cursorTo, apiCalls}>}
 */
async function runSync(school, { kind = 'cdc', jobId = null, triggeredBy = null, now = () => new Date(), makeClient } = {}) {
  const { rows } = await db.query(queries.selectConnection, [school]);
  const conn = rows[0];
  if (!conn) throw new NeedsReconnectError('QuickBooks is not connected for this school');
  if (conn.status !== 'active') throw new NeedsReconnectError();

  const settings = resolveSettings(conn.settings || {});
  let mode = chooseMode(kind, conn, now());
  const apiCalls = { n: 0 };
  const onCall = () => { apiCalls.n += 1; };
  const client = makeClient
    ? makeClient({ school, realmId: conn.realm_id, onCall })
    : createClient({ school, realmId: conn.realm_id, getToken: (o) => getAccessToken(school, o), onCall });
  const ctx = { school, realmId: conn.realm_id, settings, client };

  const cursorFrom = mode === 'cdc' ? new Date(conn.cdc_cursor) : null;
  const { rows: runRows } = await db.query(queries.insertRun, [school, jobId, kind, mode, cursorFrom, triggeredBy]);
  const run = runRows[0];
  const startedAt = new Date(run.started_at);
  const counts = { customers: 0, invoices: 0, payments: 0, deleted: 0 };

  try {
    if (mode === 'full') {
      await runFull(ctx, counts, startedAt);
    } else if (await runCdc(ctx, counts, cursorFrom)) {
      mode = 'full';
      await db.query(queries.markRunFull, [run.run_id]);
      await runFull(ctx, counts, startedAt);
    }

    const cursorTo = new Date(startedAt.getTime() - CURSOR_OVERLAP_MS);
    await db.query(queries.finishRun, [run.run_id, counts.customers, counts.invoices, counts.payments, counts.deleted, apiCalls.n, cursorTo]);
    await db.query(queries.recordSyncSuccess, [school, cursorTo]);
    logger.info({ school, mode, ...counts, apiCalls: apiCalls.n }, 'QuickBooks sync complete');
    return { runId: run.run_id, mode, counts, cursorTo, apiCalls: apiCalls.n };
  } catch (error) {
    const message = String(error.message || error);
    await db.query(queries.failRun, [run.run_id, message, apiCalls.n]).catch(() => {});
    const { rows: failRows } = await db.query(queries.recordSyncFailure, [school, message]);
    const consecutiveFailures = failRows[0]?.consecutive_failures ?? (conn.consecutive_failures || 0) + 1;
    const needsReconnect = Boolean(error.needsReconnect);
    if (needsReconnect) {
      // Without this the 15-minute schedule re-creates a job every tick and each
      // attempt burns another refresh-token rotation.
      await db.query(queries.markConnectionNeedsReconnect, [school]).catch(() => {});
    }
    logger.warn({ school, mode, err: message, consecutiveFailures }, 'QuickBooks sync failed');

    if (needsReconnect || consecutiveFailures >= ALERT_AFTER_FAILURES) {
      await alerts.notifySyncFailure({
        school, consecutiveFailures, needsReconnect, error: message,
        alertedAt: failRows[0]?.alerted_at ?? conn.alerted_at ?? null,
      });
    }
    throw error;
  }
}

module.exports = { runSync, chooseMode, CDC_MAX_AGE_MS, CURSOR_OVERLAP_MS, ALERT_AFTER_FAILURES };
