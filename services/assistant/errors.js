// services/assistant/errors.js

/**
 * A tool could not do what was asked. The message is written for the model:
 * it is handed back as the tool's answer so Muley can explain or try another
 * way. Nothing in it may be an id, an education number or a contact detail.
 */
class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** The model provider failed. `retryable` is true when sending the same request again may work. */
class ProviderError extends Error {
  constructor(kind, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind; // 'rate_limit' | 'overloaded' | 'invalid_request' | 'auth' | 'timeout' | 'aborted' | 'failed'
    this.status = status;
    this.retryable = retryable;
  }
}

module.exports = { ToolError, ProviderError };
