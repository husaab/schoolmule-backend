// services/google/googleSignIn.js
//
// "Sign in with Google": turns the one-time code from Google's sign-in popup
// into a verified Google identity.
//
// Same Google Cloud OAuth client as the Sheets integration, but none of its
// Drive access: the popup asks only for `openid email profile`, and nothing
// from the exchange is stored except the account id (users.google_sub).
//
// The popup flow ("postmessage") means Google hands the code straight back to
// the page that opened it, so there is no redirect URI to register; the
// client's Authorized JavaScript origins are what Google checks instead.

const { googleApi, isInvalidGrant } = require('./googleAuth');

/**
 * The code could not be turned into a signed-in Google identity for a reason
 * the person can retry: it expired, was already used, or the popup was
 * tampered with. Distinct from configuration errors, which stay 500s.
 */
class GoogleSignInError extends Error {
  constructor(message = 'Google sign-in failed. Please try again.') {
    super(message);
    this.name = 'GoogleSignInError';
  }
}

/**
 * Exchanges the popup's code and verifies the ID token Google returns.
 *
 * The ID token is checked against our client id (audience), Google's signing
 * keys and its expiry by google-auth-library, so a token minted for another
 * app can never sign anyone in here.
 *
 * @returns {Promise<{ sub: string, email: string, emailVerified: boolean, hd: string|null,
 *   givenName: string, familyName: string, name: string }>}
 */
async function verifySignInCode(code) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  }

  const client = new (googleApi().auth.OAuth2)(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'postmessage');

  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (error) {
    // invalid_grant: the code expired, was already redeemed, or is not ours.
    if (isInvalidGrant(error)) throw new GoogleSignInError();
    throw error;
  }

  if (!tokens.id_token) throw new GoogleSignInError('Google did not confirm who you are. Please try again.');

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload() || {};
  if (!payload.sub || !payload.email) {
    throw new GoogleSignInError('Google did not share an email address for this account.');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    // The Google Workspace domain of a school account (null for a personal one).
    hd: payload.hd || null,
    givenName: payload.given_name || '',
    familyName: payload.family_name || '',
    name: payload.name || '',
  };
}

module.exports = { verifySignInCode, GoogleSignInError };
