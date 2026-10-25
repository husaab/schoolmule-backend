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
//
// The mobile app gets its code from Google's OAuth page with the platform's
// own iOS or Android client and PKCE (RFC 7636). Native clients have no
// secret, so the code is redeemed with that client's id, the reversed-id
// redirect URI Google sent it to and the app's code verifier, and the ID
// token must be minted for that same client. GOOGLE_NATIVE_CLIENT_IDS lists
// the client ids the app may use (comma-separated).

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

const nativeClientIds = () =>
  (process.env.GOOGLE_NATIVE_CLIENT_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);

/** The only redirect URI Google allows an iOS or Android client: its id reversed as a scheme. */
const reversedRedirectUri = (clientId) => {
  const m = /^(.+)\.apps\.googleusercontent\.com$/.exec(clientId);
  return m ? `com.googleusercontent.apps.${m[1]}:/oauthredirect` : null;
};

/** The native-client fields of a request body, or undefined (the web's popup sends none). */
const nativeFieldsOf = (body) => {
  const { clientId, redirectUri, codeVerifier } = body ?? {};
  return clientId === undefined ? undefined : { clientId, redirectUri, codeVerifier };
};

/**
 * The fields the app sends with a native code, checked, or null for a web
 * popup code. Throws GoogleSignInError when they don't belong to our app.
 */
function nativeRedemption(native) {
  if (!native || native.clientId === undefined) return null;
  const { clientId, redirectUri, codeVerifier } = native;
  const allowed = typeof clientId === 'string' && nativeClientIds().includes(clientId);
  // RFC 7636: 43 to 128 characters from the unreserved set.
  const verifierOk = typeof codeVerifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier);
  if (!allowed || redirectUri !== reversedRedirectUri(clientId) || !verifierOk) {
    throw new GoogleSignInError('Google sign-in is not available in this version of the app.');
  }
  return { clientId, redirectUri, codeVerifier };
}

/**
 * Exchanges a sign-in code and verifies the ID token Google returns.
 *
 * `native` is what the mobile app sends with its code ({ clientId,
 * redirectUri, codeVerifier }); leave it out for the web's popup code.
 *
 * The ID token is checked against the client id the code was issued to
 * (audience), Google's signing keys and its expiry by google-auth-library, so
 * a token minted for another app can never sign anyone in here.
 *
 * @returns {Promise<{ sub: string, email: string, emailVerified: boolean, hd: string|null,
 *   givenName: string, familyName: string, name: string }>}
 */
async function verifySignInCode(code, native) {
  const app = nativeRedemption(native);
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!app && (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)) {
    throw new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  }

  const OAuth2 = googleApi().auth.OAuth2;
  const client = app
    ? new OAuth2(app.clientId, undefined, app.redirectUri)
    : new OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'postmessage');
  const audience = app ? app.clientId : GOOGLE_CLIENT_ID;

  let tokens;
  try {
    ({ tokens } = await client.getToken(
      app ? { code, codeVerifier: app.codeVerifier, redirect_uri: app.redirectUri } : code,
    ));
  } catch (error) {
    // invalid_grant: the code expired, was already redeemed, or is not ours.
    if (isInvalidGrant(error)) throw new GoogleSignInError();
    throw error;
  }

  if (!tokens.id_token) throw new GoogleSignInError('Google did not confirm who you are. Please try again.');

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience });
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

module.exports = { verifySignInCode, nativeFieldsOf, GoogleSignInError };
