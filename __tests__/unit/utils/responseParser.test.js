jest.mock('../../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const responseHandler = require('../../../utils/responseParser');

describe('responseParser (responseHandler)', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('wraps a successful controller result into standard response', async () => {
    const controller = jest.fn().mockResolvedValue({
      status: 200,
      message: 'Data fetched',
      data: { id: '123' },
    });

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Data fetched',
      data: { id: '123' },
    });
  });

  it('uses default status 200 when controller does not provide status', async () => {
    const controller = jest.fn().mockResolvedValue({
      message: 'OK',
      data: null,
    });

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('uses default message when controller does not provide message', async () => {
    const controller = jest.fn().mockResolvedValue({
      status: 200,
      data: { id: '123' },
    });

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Request successful',
      })
    );
  });

  it('includes pagination when controller provides it', async () => {
    const controller = jest.fn().mockResolvedValue({
      status: 200,
      message: 'Paginated',
      data: [1, 2, 3],
      pagination: { page: 1, total: 10 },
    });

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: { page: 1, total: 10 },
      })
    );
  });

  it('handles controller errors with error status and message', async () => {
    const error = new Error('Something failed');
    error.status = 400;
    const controller = jest.fn().mockRejectedValue(error);

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Something failed',
    });
  });

  it('defaults to 500 when error has no status', async () => {
    const controller = jest.fn().mockRejectedValue(new Error('Unknown error'));

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Unknown error',
    });
  });

  it('defaults to "Internal Server Error" when error has no message', async () => {
    const controller = jest.fn().mockRejectedValue({});

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal Server Error',
    });
  });

  it('does not send response when controller returns undefined', async () => {
    const controller = jest.fn().mockResolvedValue(undefined);

    const handler = responseHandler(controller);
    await handler(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
