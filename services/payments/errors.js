// services/payments/errors.js
//
// The error vocabulary for Stripe calls. Callers key on two things: whether
// the server is set up for payments at all (StripeConfigError), and whether a
// failed call is worth trying again (`retryable`).

/** The server has no usable Stripe key, or the key is not allowed here. */
class StripeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

/** Any failed call to Stripe. */
class StripeApiError extends Error {
  constructor(message, { status = null, code = null, type = null, retryable = false } = {}) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryable = retryable;
  }
}

module.exports = { StripeConfigError, StripeApiError };
