const { verify, sign, secretsFromEnv, WebhookSignatureError } = require('../../../../services/payments/webhookSignature');

const SECRET = 'whsec_unit_test_secret';
const BODY = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'account.updated', livemode: false }));
const NOW = 1_800_000_000_000;
const T = NOW / 1000;

describe('webhookSignature.verify', () => {
  it('accepts a body signed with this server’s secret', () => {
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    expect(verify({ rawBody: BODY, header, secrets: [SECRET], now: NOW })).toBe(true);
  });

  it('accepts the body as a string too', () => {
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    expect(verify({ rawBody: BODY.toString('utf8'), header, secrets: [SECRET], now: NOW })).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    const header = sign({ rawBody: BODY, secret: 'whsec_someone_else', timestamp: T });
    expect(() => verify({ rawBody: BODY, header, secrets: [SECRET], now: NOW })).toThrow(WebhookSignatureError);
  });

  it('refuses a body that was changed after signing, even by re-serializing it', () => {
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 1));
    expect(() => verify({ rawBody: reserialized, header, secrets: [SECRET], now: NOW })).toThrow(/No signature matches/);
  });

  it('refuses a correctly signed request that is too old, or from too far ahead', () => {
    const old = sign({ rawBody: BODY, secret: SECRET, timestamp: T - 301 });
    expect(() => verify({ rawBody: BODY, header: old, secrets: [SECRET], now: NOW })).toThrow(/too old/);
    const ahead = sign({ rawBody: BODY, secret: SECRET, timestamp: T + 301 });
    expect(() => verify({ rawBody: BODY, header: ahead, secrets: [SECRET], now: NOW })).toThrow(/too old/);
    const recent = sign({ rawBody: BODY, secret: SECRET, timestamp: T - 299 });
    expect(verify({ rawBody: BODY, header: recent, secrets: [SECRET], now: NOW })).toBe(true);
  });

  it('cannot be replayed by moving the timestamp forward', () => {
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T - 9999 }).replace(/t=\d+/, `t=${T}`);
    expect(() => verify({ rawBody: BODY, header, secrets: [SECRET], now: NOW })).toThrow(/No signature matches/);
  });

  it('accepts any of several signatures and any of several secrets', () => {
    const good = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    const header = `${good},v1=${'0'.repeat(64)},v0=ignored`;
    expect(verify({ rawBody: BODY, header, secrets: ['whsec_other_endpoint', SECRET], now: NOW })).toBe(true);
  });

  it('refuses a missing or malformed header, and a missing body', () => {
    for (const header of [undefined, '', 'nonsense', 't=abc,v1=00', `t=${T}`, 'v1=00']) {
      expect(() => verify({ rawBody: BODY, header, secrets: [SECRET], now: NOW })).toThrow(WebhookSignatureError);
    }
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    // A parsed object is what a JSON body parser would have left: not the raw bytes.
    expect(() => verify({ rawBody: { id: 'evt_1' }, header, secrets: [SECRET], now: NOW })).toThrow(/raw request body/);
  });

  it('refuses everything when the server has no secret', () => {
    const header = sign({ rawBody: BODY, secret: SECRET, timestamp: T });
    expect(() => verify({ rawBody: BODY, header, secrets: [], now: NOW })).toThrow(WebhookSignatureError);
  });
});

describe('webhookSignature.secretsFromEnv', () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = saved;
  });

  it('reads one secret, or several separated by commas', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(secretsFromEnv()).toEqual([]);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_a';
    expect(secretsFromEnv()).toEqual(['whsec_a']);
    process.env.STRIPE_WEBHOOK_SECRET = ' whsec_a , whsec_b ,';
    expect(secretsFromEnv()).toEqual(['whsec_a', 'whsec_b']);
  });
});
