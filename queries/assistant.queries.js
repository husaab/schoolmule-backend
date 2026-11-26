// queries/assistant.queries.js
// Muley, the assistant: settings, conversations and messages
// (database/migrations/assistant_core_migration.sql).

module.exports = {
  // ── Settings ────────────────────────────────────────────────
  selectSettings: `
    SELECT school, enabled, role_teacher, role_admin, role_parent, allow_writes, allow_outward,
           self_serve, transcript_retention_days, updated_at
    FROM ai_assistant_settings
    WHERE school = $1
  `,

  // $1 school, $2..$8 the switches, $9 retention days, $10 who
  upsertSettings: `
    INSERT INTO ai_assistant_settings (
      school, enabled, role_teacher, role_admin, role_parent, allow_writes, allow_outward,
      self_serve, transcript_retention_days, updated_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (school) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      role_teacher = EXCLUDED.role_teacher,
      role_admin = EXCLUDED.role_admin,
      role_parent = EXCLUDED.role_parent,
      allow_writes = EXCLUDED.allow_writes,
      allow_outward = EXCLUDED.allow_outward,
      self_serve = EXCLUDED.self_serve,
      transcript_retention_days = EXCLUDED.transcript_retention_days,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING school, enabled, role_teacher, role_admin, role_parent, allow_writes, allow_outward,
              self_serve, transcript_retention_days, updated_at
  `,

  // ── Conversations ───────────────────────────────────────────
  insertConversation: `
    INSERT INTO assistant_conversations (school, user_id, view, school_year_id)
    VALUES ($1, $2, $3, $4)
    RETURNING conversation_id, school, user_id, view, school_year_id, title, refs, created_at, last_message_at
  `,

  // A conversation belongs to one person in one view at one school.
  selectConversation: `
    SELECT conversation_id, school, user_id, view, school_year_id, title, refs, created_at, last_message_at
    FROM assistant_conversations
    WHERE conversation_id = $1 AND user_id = $2 AND view = $3 AND school = $4
  `,

  selectConversations: `
    SELECT conversation_id, title, created_at, last_message_at
    FROM assistant_conversations
    WHERE user_id = $1 AND view = $2 AND school = $3
    ORDER BY last_message_at DESC
    LIMIT $4
  `,

  updateTitle: `
    UPDATE assistant_conversations SET title = $2
    WHERE conversation_id = $1 AND user_id = $3 AND view = $4 AND school = $5
    RETURNING conversation_id, title
  `,

  deleteConversation: `
    DELETE FROM assistant_conversations
    WHERE conversation_id = $1 AND user_id = $2 AND view = $3 AND school = $4
    RETURNING conversation_id
  `,

  // One turn at a time per conversation: claimed only when no turn holds it,
  // or the one that does started more than three minutes ago (it died).
  claimTurn: `
    UPDATE assistant_conversations
    SET active_turn_id = $2, active_turn_started_at = NOW()
    WHERE conversation_id = $1
      AND (active_turn_id IS NULL OR active_turn_started_at < NOW() - INTERVAL '3 minutes')
    RETURNING conversation_id
  `,

  releaseTurn: `
    UPDATE assistant_conversations
    SET active_turn_id = NULL, active_turn_started_at = NULL
    WHERE conversation_id = $1 AND active_turn_id = $2
  `,

  // After a turn: the refs it minted, the title if it has none yet, and the time.
  touchConversation: `
    UPDATE assistant_conversations
    SET refs = $2::jsonb, title = COALESCE(title, $3), last_message_at = NOW()
    WHERE conversation_id = $1
  `,

  // ── Messages ────────────────────────────────────────────────
  // seq is the next number in this conversation; the claim above means only
  // one turn appends at a time.
  insertMessage: `
    INSERT INTO assistant_messages (
      conversation_id, seq, turn_id, role, content, tool_calls, tool_call_id, tool_name,
      display, model, input_tokens, cached_input_tokens, output_tokens
    )
    SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12
    FROM assistant_messages
    WHERE conversation_id = $1
    RETURNING message_id, seq
  `,

  selectMessages: `
    SELECT message_id, seq, turn_id, role, content, tool_calls, tool_call_id, tool_name, display, created_at
    FROM assistant_messages
    WHERE conversation_id = $1
    ORDER BY seq
  `,

  selectFirstName: `SELECT first_name FROM users WHERE user_id = $1`,
};
