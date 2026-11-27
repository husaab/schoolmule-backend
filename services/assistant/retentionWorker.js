// services/assistant/retentionWorker.js
//
// Deletes Muley conversations nobody has added to for longer than their
// school keeps them (ai_assistant_settings.transcript_retention_days, 90
// unless the school changed it; a school with no settings row keeps 90), once
// a day, in bounded batches. Messages go with their conversation. The record
// of changes Muley made (assistant_actions, audit_log) is kept apart and is
// not touched here. The same daily sweep removes images attached in the
// panel once they are two days old (attachments.prune).

const db = require('../../config/database');
const logger = require('../../logger');
const attachments = require('./attachments');

const DEFAULT_DAYS = 90;
const BATCH = 500;
const CHECK_MS = 60 * 60 * 1000;

let timer = null;
let lastSweepDate = null;
let sweeping = false;

const torontoDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

const deleteExpired = `
  DELETE FROM assistant_conversations
  WHERE conversation_id IN (
    SELECT c.conversation_id
    FROM assistant_conversations c
    LEFT JOIN ai_assistant_settings s ON s.school = c.school
    WHERE c.last_message_at < NOW() - make_interval(days => COALESCE(s.transcript_retention_days, ${DEFAULT_DAYS}))
    ORDER BY c.last_message_at
    LIMIT ${BATCH}
  )
`;

/** One sweep. -> how many conversations were deleted. */
async function sweepOnce() {
  let deleted = 0;
  for (;;) {
    const { rowCount } = await db.query(deleteExpired);
    deleted += rowCount || 0;
    if (!rowCount || rowCount < BATCH) break;
  }
  return deleted;
}

function startWorker(intervalMs = CHECK_MS) {
  if (timer) return;
  timer = setInterval(async () => {
    if (sweeping) return;
    const today = torontoDate();
    if (lastSweepDate === today) return;
    sweeping = true;
    try {
      const deleted = await sweepOnce();
      const images = await attachments.prune();
      lastSweepDate = today;
      logger.info({ assistant: true, deleted, images }, 'assistant: conversation retention sweep complete');
    } catch (err) {
      logger.warn({ assistant: true, err }, 'assistant: conversation retention sweep failed');
    } finally {
      sweeping = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startWorker, stopWorker, sweepOnce, DEFAULT_DAYS };
