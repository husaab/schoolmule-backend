const errorHandler = require('../../../middleware/errorHandler');

const makeRes = () => {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const makeReq = () => ({
  method: 'GET',
  originalUrl: '/api/test',
  log: { error: jest.fn() },
});

const run = (err) => {
  const res = makeRes();
  errorHandler(err, makeReq(), res, jest.fn());
  return res;
};

describe('errorHandler', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  describe('in production', () => {
    beforeEach(() => { process.env.NODE_ENV = 'production'; });

    it.each([400, 404, 409])('keeps the message of a thrown %i verdict', (status) => {
      const res = run({ status, message: 'This verification link is invalid' });
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ success: false, message: 'This verification link is invalid' });
    });

    it('masks a 500 and hides the stack', () => {
      const res = run(new Error('connection refused at 10.0.0.3'));
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ success: false, message: 'Internal Server Error' });
    });

    it('masks an explicit 503 too', () => {
      const res = run({ status: 503, message: 'pool exhausted' });
      expect(res.body.message).toBe('Internal Server Error');
    });

    it('never sends the stack, even for a 4xx', () => {
      const err = new Error('Bad input');
      err.status = 400;
      expect(run(err).body.stack).toBeUndefined();
    });
  });

  describe('outside production', () => {
    beforeEach(() => { process.env.NODE_ENV = 'test'; });

    it('passes the 500 message and stack through', () => {
      const res = run(new Error('boom'));
      expect(res.statusCode).toBe(500);
      expect(res.body.message).toBe('boom');
      expect(res.body.stack).toContain('boom');
    });
  });

  it('hands off when headers were already sent', () => {
    const res = makeRes();
    res.headersSent = true;
    const next = jest.fn();
    const err = new Error('late');
    errorHandler(err, makeReq(), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBeNull();
  });
});
