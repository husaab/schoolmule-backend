// Mock googleapis before requiring anything that pulls it in.
const mockGenerateAuthUrl = jest.fn(() => 'https://accounts.google.com/o/oauth2/auth?mock');
const mockGetToken = jest.fn();
const mockGetAccessToken = jest.fn();
const mockSetCredentials = jest.fn();
const mockUserinfoGet = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: mockGenerateAuthUrl,
        getToken: mockGetToken,
        getAccessToken: mockGetAccessToken,
        setCredentials: mockSetCredentials,
      })),
    },
    oauth2: jest.fn(() => ({ userinfo: { get: mockUserinfoGet } })),
  },
}));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const {
  buildAuthUrl,
  exchangeCode,
  saveConnection,
  getAuthorizedClient,
  isInvalidGrant,
  NeedsReconnectError,
  SCOPES,
} = require('../../../../services/google/googleAuth');
const { decryptToken } = require('../../../../utils/tokenCrypto');

describe('googleAuth', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/registration/google/callback';
    process.env.GOOGLE_TOKEN_ENC_KEY = Buffer.alloc(32, 3).toString('base64');
  });

  describe('scope', () => {
    it('requests drive.file plus only the basic identity scopes', () => {
      expect(SCOPES).toEqual([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/drive.file',
      ]);
    });

    it('requests no sensitive scope', () => {
      // `spreadsheets` or full `drive` would push the app into sensitive-scope
      // verification and gate it behind a Google review.
      expect(SCOPES).not.toContain('https://www.googleapis.com/auth/spreadsheets');
      expect(SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
    });

    it('includes the scope userinfo.get() needs, or exchangeCode fails at runtime', () => {
      // exchangeCode reads the account email to show "Connected as …"; with
      // only drive.file that call returns an insufficient-scope error.
      expect(SCOPES).toContain('https://www.googleapis.com/auth/userinfo.email');
    });
  });

  describe('buildAuthUrl', () => {
    it('asks for offline access and forces consent, so a refresh token is issued', () => {
      buildAuthUrl({ nonce: 'abc123' });
      const opts = mockGenerateAuthUrl.mock.calls.at(-1)[0];
      expect(opts.access_type).toBe('offline');
      // Without prompt=consent a reconnect returns no refresh token and the
      // integration silently becomes single-session.
      expect(opts.prompt).toBe('consent');
      expect(opts.scope).toEqual(SCOPES);
      expect(opts.state).toBe('abc123');
    });

    it('throws a clear error when OAuth env is missing', () => {
      delete process.env.GOOGLE_CLIENT_ID;
      expect(() => buildAuthUrl({ nonce: 'x' })).toThrow(/not configured/);
    });
  });

  describe('exchangeCode', () => {
    it('returns the refresh token and the account email', async () => {
      mockGetToken.mockResolvedValueOnce({ tokens: { refresh_token: 'rt-123', access_token: 'at' } });
      mockUserinfoGet.mockResolvedValueOnce({ data: { email: 'admin@school.ca' } });

      await expect(exchangeCode('code-abc'))
        .resolves.toEqual({ refreshToken: 'rt-123', email: 'admin@school.ca' });
    });

    it('fails loudly when Google returns no refresh token', async () => {
      mockGetToken.mockResolvedValueOnce({ tokens: { access_token: 'at' } });
      await expect(exchangeCode('code-abc')).rejects.toThrow(/did not return a refresh token/);
    });
  });

  describe('saveConnection', () => {
    it('encrypts the refresh token before storing it', async () => {
      mockQueryResponse([{ connection_id: 'c1', school: 'ALHAADIACADEMY' }]);
      await saveConnection({
        school: 'ALHAADIACADEMY', email: 'a@b.ca', refreshToken: 'rt-secret', userId: 'u1',
      });

      const [, params] = db.query.mock.calls.at(-1);
      expect(params[2]).not.toContain('rt-secret');       // not stored in the clear
      expect(decryptToken(params[2])).toBe('rt-secret');  // but recoverable
    });
  });

  describe('isInvalidGrant', () => {
    it('recognizes the error in each place Google surfaces it', () => {
      expect(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
      expect(isInvalidGrant({ data: { error: 'invalid_grant' } })).toBe(true);
      expect(isInvalidGrant({ message: 'invalid_grant: Token has been expired or revoked.' })).toBe(true);
    });

    it('does not mistake other failures for a dead grant', () => {
      expect(isInvalidGrant({ message: 'socket hang up' })).toBe(false);
      expect(isInvalidGrant({ response: { data: { error: 'rate_limit_exceeded' } } })).toBe(false);
    });
  });

  describe('getAuthorizedClient', () => {
    const connectionRow = (over = {}) => ({
      connection_id: 'c1',
      school: 'ALHAADIACADEMY',
      google_email: 'a@b.ca',
      refresh_token: require('../../../../utils/tokenCrypto').encryptToken('rt-123'),
      status: 'active',
      ...over,
    });

    it('returns a client for an active connection', async () => {
      mockQueryResponse([connectionRow()]);
      mockGetAccessToken.mockResolvedValueOnce({ token: 'at' });

      const client = await getAuthorizedClient('ALHAADIACADEMY');
      expect(client).toBeDefined();
      // The stored token is decrypted before use.
      expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-123' });
    });

    it('needs reconnect when the school has never connected', async () => {
      mockQueryResponse([]);
      await expect(getAuthorizedClient('ALHAADIACADEMY')).rejects.toThrow(NeedsReconnectError);
    });

    it('needs reconnect when the connection is already flagged', async () => {
      mockQueryResponse([connectionRow({ status: 'needs_reconnect' })]);
      await expect(getAuthorizedClient('ALHAADIACADEMY')).rejects.toThrow(NeedsReconnectError);
    });

    it('flags the connection and needs reconnect on invalid_grant', async () => {
      mockQueryResponse([connectionRow()]);
      mockQueryResponse([{ status: 'needs_reconnect' }]); // the flagging update
      mockGetAccessToken.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } } });

      await expect(getAuthorizedClient('ALHAADIACADEMY')).rejects.toThrow(NeedsReconnectError);

      const sqls = db.query.mock.calls.map((c) => c[0]);
      expect(sqls.some((s) => /needs_reconnect/.test(s))).toBe(true);
    });

    it('asks for a reconnect when the stored token cannot be decrypted', async () => {
      // Happens when GOOGLE_TOKEN_ENC_KEY is rotated. Retrying can never fix
      // it, and "reconnect" is the actual remedy — so it must not surface as a
      // raw crypto error the school can do nothing about.
      mockQueryResponse([connectionRow({ refresh_token: 'not:valid:ciphertext' })]);
      mockQueryResponse([{ status: 'needs_reconnect' }]);

      await expect(getAuthorizedClient('ALHAADIACADEMY')).rejects.toThrow(NeedsReconnectError);
      expect(db.query.mock.calls.some(([sql]) => /needs_reconnect/.test(sql))).toBe(true);
    });

    it('rethrows a transient failure unchanged, keeping it retryable', async () => {
      mockQueryResponse([connectionRow()]);
      mockGetAccessToken.mockRejectedValueOnce(new Error('socket hang up'));

      // Misreporting this as a dead grant would make the school reconnect for
      // no reason and would stop the job retrying.
      await expect(getAuthorizedClient('ALHAADIACADEMY')).rejects.toThrow('socket hang up');
      const sqls = db.query.mock.calls.map((c) => c[0]);
      expect(sqls.some((s) => /needs_reconnect/.test(s))).toBe(false);
    });
  });
});
