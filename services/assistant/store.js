// services/assistant/store.js
//
// Conversations and their messages, as Muley stores them: in our own
// database, in a provider-neutral shape (see provider/openaiAdapter.js), and
// scrubbed on the way in. A conversation belongs to one person in one view
// at one school; every read and change here names all three.

const db = require('../../config/database');
const queries = require('../../queries/assistant.queries');
const { scrubText, scrubResult } = require('./tools/shape/scrub');

const owner = (who) => [who.userId, who.view, who.school];

const toConversation = (row) => row && ({
  id: row.conversation_id,
  school: row.school,
  userId: row.user_id,
  view: row.view,
  schoolYearId: row.school_year_id,
  title: row.title,
  refs: row.refs || {},
  createdAt: row.created_at,
  lastMessageAt: row.last_message_at,
});

async function create(who, schoolYearId) {
  const { rows } = await db.query(queries.insertConversation, [who.school, who.userId, who.view, schoolYearId]);
  return toConversation(rows[0]);
}

async function find(conversationId, who) {
  const { rows } = await db.query(queries.selectConversation, [conversationId, ...owner(who)]);
  return toConversation(rows[0]) || null;
}

async function list(who, limit = 30) {
  const { rows } = await db.query(queries.selectConversations, [...owner(who), limit]);
  return rows.map((r) => ({ id: r.conversation_id, title: r.title, createdAt: r.created_at, lastMessageAt: r.last_message_at }));
}

async function rename(conversationId, title, who) {
  const { rows } = await db.query(queries.updateTitle, [conversationId, scrubText(String(title).slice(0, 80)), ...owner(who)]);
  return rows[0] ? { id: rows[0].conversation_id, title: rows[0].title } : null;
}

async function remove(conversationId, who) {
  const { rows } = await db.query(queries.deleteConversation, [conversationId, ...owner(who)]);
  return rows.length > 0;
}

/** Take the conversation for one turn. False when another turn is running in it. */
async function claimTurn(conversationId, turnId) {
  const { rows } = await db.query(queries.claimTurn, [conversationId, turnId]);
  return rows.length > 0;
}

const releaseTurn = (conversationId, turnId) => db.query(queries.releaseTurn, [conversationId, turnId]);

/** After a turn: keep the refs it minted and give the conversation a title if it has none. */
const touch = (conversationId, refs, title) =>
  db.query(queries.touchConversation, [conversationId, JSON.stringify(refs), title ? scrubText(String(title).slice(0, 80)) : null]);

/**
 * Append one message. Text is scrubbed here, so nothing shaped like an
 * education number is ever stored, whoever wrote it.
 * @param {{ role: 'user'|'assistant'|'tool'|'event', content?: string|null, toolCalls?: object[]|null,
 *   toolCallId?: string|null, toolName?: string|null, display?: object|null, model?: string|null,
 *   usage?: { input: number, cachedInput: number, output: number }|null }} message
 */
async function append(conversationId, turnId, message) {
  const { rows } = await db.query(queries.insertMessage, [
    conversationId,
    turnId,
    message.role,
    message.content === undefined || message.content === null ? null : scrubText(String(message.content)),
    message.toolCalls ? JSON.stringify(scrubResult(message.toolCalls)) : null,
    message.toolCallId || null,
    message.toolName || null,
    message.display ? JSON.stringify(message.display) : null,
    message.model || null,
    message.usage ? message.usage.input : null,
    message.usage ? message.usage.cachedInput : null,
    message.usage ? message.usage.output : null,
  ]);
  return { id: rows[0].message_id, seq: rows[0].seq };
}

/** The stored transcript, oldest first, in the neutral shape the provider adapter takes. */
async function transcript(conversationId) {
  const { rows } = await db.query(queries.selectMessages, [conversationId]);
  return rows.map((r) => ({
    id: r.message_id,
    seq: r.seq,
    turnId: r.turn_id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls || null,
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    display: r.display || null,
    createdAt: r.created_at,
  }));
}

async function firstNameOf(userId) {
  const { rows } = await db.query(queries.selectFirstName, [userId]);
  return rows[0]?.first_name || null;
}

module.exports = { create, find, list, rename, remove, claimTurn, releaseTurn, touch, append, transcript, firstNameOf };
