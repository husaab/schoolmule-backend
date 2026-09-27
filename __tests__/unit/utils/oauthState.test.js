const { signState, verifyState } = require('../../../utils/oauthState');

describe('oauthState', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'test-jwt-secret-key-for-unit-tests'; });

  it('round-trips a payload', () => {
    const state = signState({ school: 'ALHAADIACADEMY', userId: 'u1', returnTo: '/x', iat: Date.now() });
    expect(verifyState(state)).toMatchObject({ school: 'ALHAADIACADEMY', userId: 'u1', returnTo: '/x' });
  });

  it('rejects a tampered body', () => {
    const state = signState({ school: 'ALHAADIACADEMY', iat: Date.now() });
    const [body, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ school: 'PLAYGROUND', iat: Date.now() })).toString('base64url');
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
    expect(verifyState(`${body}.${sig.slice(1)}x`)).toBeNull();
  });

  it('rejects an expired state', () => {
    const state = signState({ school: 'ALHAADIACADEMY', iat: Date.now() - 11 * 60 * 1000 });
    expect(verifyState(state)).toBeNull();
    expect(verifyState(state, { ttlMs: 60 * 60 * 1000 })).not.toBeNull();
  });

  it('binds a state to its purpose so one integration\'s state cannot finish another\'s callback', () => {
    const qbo = signState({ school: 'ALHAADIACADEMY', userId: 'u1', purpose: 'qbo', iat: Date.now() });
    expect(verifyState(qbo, { purpose: 'qbo' })).toMatchObject({ purpose: 'qbo' });
    expect(verifyState(qbo, { purpose: 'google' })).toBeNull();
    const unlabelled = signState({ school: 'ALHAADIACADEMY', iat: Date.now() });
    expect(verifyState(unlabelled, { purpose: 'qbo' })).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyState(undefined)).toBeNull();
    expect(verifyState('nope')).toBeNull();
    expect(verifyState('a.b')).toBeNull();
  });
});
