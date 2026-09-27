// services/finance/errors.js
//
// The error vocabulary the sync worker keys on. Only one distinction matters
// to it: `needsReconnect` (permanent — a human must re-authorize) versus
// everything else (retry with backoff).

/** Raised when Intuit says the stored grant is dead, or was never stored. */
class NeedsReconnectError extends Error {
  constructor(message = 'QuickBooks access needs to be reconnected') {
    super(message);
    this.name = 'NeedsReconnectError';
    this.needsReconnect = true;
  }
}

/** Any non-2xx from QBO that is not a throttle or an auth failure. */
class QboApiError extends Error {
  constructor(message, { status = null, code = null, detail = null, retryable = false } = {}) {
    super(message);
    this.name = 'QboApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** 429 that outlasted the retry budget. Always retryable later. */
class QboThrottledError extends QboApiError {
  constructor(message = 'QuickBooks rate limit exceeded') {
    super(message, { status: 429, retryable: true });
    this.name = 'QboThrottledError';
  }
}

module.exports = { NeedsReconnectError, QboApiError, QboThrottledError };
