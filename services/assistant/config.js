// services/assistant/config.js
//
// Muley's switches and caps, read from the environment at the moment they
// are needed (so a test or a redeploy can change one without a restart of
// anything else).

const number = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};

module.exports = {
  /**
   * The kill switch. On unless ASSISTANT_ENABLED is "false": every school is
   * off until it is switched on (services/assistant/settings.js), so this only
   * needs setting to stop Muley everywhere at once.
   */
  enabled: () => process.env.ASSISTANT_ENABLED !== 'false',
  model: () => process.env.ASSISTANT_MODEL || 'gpt-6-luna',
  /** 'none' keeps the transcript free of reasoning items; raise it only with the adapter's support for them. */
  reasoningEffort: () => process.env.ASSISTANT_REASONING_EFFORT || 'none',
  /** Where the backend reaches its own routes (services/assistant/tools/dispatcher.js). */
  loopbackUrl: () => process.env.ASSISTANT_LOOPBACK_URL || `http://127.0.0.1:${process.env.PORT || 4000}`,
  timezone: () => process.env.ASSISTANT_TIMEZONE || 'America/Toronto',
  /** Messages one person may send in a minute. Read once, when the router is built. */
  turnsPerMinute: () => number(process.env.ASSISTANT_TURNS_PER_MINUTE, 20),

  caps: () => ({
    providerCalls: number(process.env.ASSISTANT_MAX_MODEL_CALLS, 8),   // model requests in one turn
    toolCalls: number(process.env.ASSISTANT_MAX_TOOL_CALLS, 24),       // tool runs in one turn
    maxOutputTokens: number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS, 1500),
    turnMs: number(process.env.ASSISTANT_TURN_MS, 120_000),            // wall clock for a whole turn
    toolResultChars: 8000,                                             // what one tool may hand the model
    messageChars: 4000,                                                // one message from the person
    historyMessages: 60,                                               // how much of the transcript is replayed
  }),
};
