// Mock googleapis before requiring anything that pulls it in.
const mockGetToken = jest.fn();
const mockVerifyIdToken = jest.fn();
const mockOAuth2 = jest.fn().mockImplementation(() => ({
  getToken: mockGetToken,
  verifyIdToken: mockVerifyIdToken,
}));

jest.mock('googleapis', () => ({
  google: { auth: { OAuth2: mockOAuth2 } },
}));

const { verifySignInCode, GoogleSignInError } = require('../../../../services/google/googleSignIn');

const ticket = (payload) => ({ getPayload: () => payload });

const PAYLOAD = {
  sub: '109876543210',
  email: 'parent.demo@example.com',
  email_verified: true,
  given_name: 'Demo',
  family_name: 'Parent',
  name: 'Demo Parent',
};

describe('googleSignIn.verifySignInCode', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'id-token' } });
    mockVerifyIdToken.mockResolvedValue(ticket(PAYLOAD));
  });

  it('exchanges the popup code with the postmessage redirect and verifies the ID token for our client', async () => {
    const identity = await verifySignInCode('auth-code');

    expect(mockOAuth2).toHaveBeenCalledWith('client-id', 'client-secret', 'postmessage');
    expect(mockGetToken).toHaveBeenCalledWith('auth-code');
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token', audience: 'client-id' });
    expect(identity).toEqual({
      sub: '109876543210',
      email: 'parent.demo@example.com',
      emailVerified: true,
      hd: null,
      givenName: 'Demo',
      familyName: 'Parent',
      name: 'Demo Parent',
    });
  });

  it("passes on a school account's Google Workspace domain (hd)", async () => {
    mockVerifyIdToken.mockResolvedValue(ticket({ ...PAYLOAD, hd: 'students.example.org' }));
    expect((await verifySignInCode('auth-code')).hd).toBe('students.example.org');
  });

  it('treats anything but a literal true email_verified as unverified', async () => {
    mockVerifyIdToken.mockResolvedValue(ticket({ ...PAYLOAD, email_verified: 'true' }));
    await expect(verifySignInCode('auth-code')).resolves.toMatchObject({ emailVerified: false });
  });

  it('defaults missing name parts to empty strings', async () => {
    mockVerifyIdToken.mockResolvedValue(ticket({ sub: '1', email: 'a@example.com', email_verified: true }));
    await expect(verifySignInCode('auth-code')).resolves.toMatchObject({ givenName: '', familyName: '', name: '' });
  });

  it('reports an expired or reused code as a retryable sign-in error', async () => {
    mockGetToken.mockRejectedValue(Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }));
    await expect(verifySignInCode('auth-code')).rejects.toBeInstanceOf(GoogleSignInError);
  });

  it('lets any other exchange failure through (configuration, network)', async () => {
    mockGetToken.mockRejectedValue(new Error('redirect_uri_mismatch'));
    const err = await verifySignInCode('auth-code').catch((e) => e);
    expect(err).not.toBeInstanceOf(GoogleSignInError);
    expect(err.message).toBe('redirect_uri_mismatch');
  });

  it('refuses a response without an ID token', async () => {
    mockGetToken.mockResolvedValue({ tokens: { access_token: 'at' } });
    await expect(verifySignInCode('auth-code')).rejects.toBeInstanceOf(GoogleSignInError);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('refuses an identity without an email', async () => {
    mockVerifyIdToken.mockResolvedValue(ticket({ sub: '1' }));
    await expect(verifySignInCode('auth-code')).rejects.toBeInstanceOf(GoogleSignInError);
  });

  it('fails loudly when the OAuth client is not configured', async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    await expect(verifySignInCode('auth-code')).rejects.toThrow(/not configured/);
    expect(mockGetToken).not.toHaveBeenCalled();
  });
  describe('a native (mobile app) code', () => {
    const IOS = '123-abc.apps.googleusercontent.com';
    const native = (over = {}) => ({
      clientId: IOS,
      redirectUri: 'com.googleusercontent.apps.123-abc:/oauthredirect',
      codeVerifier: 'v'.repeat(43),
      ...over,
    });

    beforeEach(() => {
      process.env.GOOGLE_NATIVE_CLIENT_IDS = `${IOS}, 456-def.apps.googleusercontent.com`;
    });
    afterEach(() => {
      delete process.env.GOOGLE_NATIVE_CLIENT_IDS;
    });

    it("redeems with the app's client, its reversed redirect and the PKCE verifier, no secret", async () => {
      await verifySignInCode('app-code', native());

      expect(mockOAuth2).toHaveBeenCalledWith(IOS, undefined, 'com.googleusercontent.apps.123-abc:/oauthredirect');
      expect(mockGetToken).toHaveBeenCalledWith({
        code: 'app-code',
        codeVerifier: 'v'.repeat(43),
        redirect_uri: 'com.googleusercontent.apps.123-abc:/oauthredirect',
      });
      expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token', audience: IOS });
    });

    it('works without the web client configured', async () => {
      delete process.env.GOOGLE_CLIENT_SECRET;
      await expect(verifySignInCode('app-code', native())).resolves.toMatchObject({ sub: PAYLOAD.sub });
    });

    it.each([
      ['a client id that is not ours', { clientId: '999-zzz.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.999-zzz:/oauthredirect' }],
      ['a redirect for another client', { redirectUri: 'com.googleusercontent.apps.456-def:/oauthredirect' }],
      ['a custom redirect', { redirectUri: 'schoolmule://oauth' }],
      ['a short verifier', { codeVerifier: 'short' }],
      ['no verifier', { codeVerifier: undefined }],
    ])('refuses %s before calling Google', async (_label, over) => {
      await expect(verifySignInCode('app-code', native(over))).rejects.toBeInstanceOf(GoogleSignInError);
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('refuses every native code when no native client is configured', async () => {
      delete process.env.GOOGLE_NATIVE_CLIENT_IDS;
      await expect(verifySignInCode('app-code', native())).rejects.toBeInstanceOf(GoogleSignInError);
    });
  });

  describe('nativeFieldsOf', () => {
    const { nativeFieldsOf } = require('../../../../services/google/googleSignIn');

    it('is undefined for a web popup body', () => {
      expect(nativeFieldsOf({ code: 'c', intent: 'login' })).toBeUndefined();
      expect(nativeFieldsOf(undefined)).toBeUndefined();
    });

    it("picks the app's fields and nothing else", () => {
      expect(nativeFieldsOf({ code: 'c', clientId: 'id', redirectUri: 'r', codeVerifier: 'v', platform: 'ios' }))
        .toEqual({ clientId: 'id', redirectUri: 'r', codeVerifier: 'v' });
    });
  });
});
