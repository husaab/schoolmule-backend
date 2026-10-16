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
      givenName: 'Demo',
      familyName: 'Parent',
      name: 'Demo Parent',
    });
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
});
