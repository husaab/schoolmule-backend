const requirePlatformOwner = require('../../../middleware/requirePlatformOwner');
const { isPlatformOwner, ownerEmails } = requirePlatformOwner;

const res = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };

describe('requirePlatformOwner', () => {
  beforeEach(() => { process.env.PLATFORM_OWNER_EMAILS = ' Owner@Example.com, second@example.com '; });
  afterEach(() => { delete process.env.PLATFORM_OWNER_EMAILS; });

  it('parses, trims and lowercases the allowlist', () => {
    expect(ownerEmails()).toEqual(['owner@example.com', 'second@example.com']);
  });
  it('matches case-insensitively', () => {
    expect(isPlatformOwner('OWNER@example.COM')).toBe(true);
    expect(isPlatformOwner('nobody@example.com')).toBe(false);
    expect(isPlatformOwner(null)).toBe(false);
  });
  it('is closed when the env var is empty', () => {
    process.env.PLATFORM_OWNER_EMAILS = '';
    expect(isPlatformOwner('owner@example.com')).toBe(false);
  });
  it('passes an owner', () => {
    const next = jest.fn(); const r = res();
    requirePlatformOwner({ user: { email: 'owner@example.com', role: 'ADMIN' } }, r, next);
    expect(next).toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });
  it('refuses a school admin with 403 and a bare message', () => {
    const next = jest.fn(); const r = res();
    requirePlatformOwner({ user: { email: 'admin@school.com', role: 'ADMIN' } }, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ status: 'failed', message: 'Forbidden' });
  });
  it('refuses an impersonation token even for the owner', () => {
    const next = jest.fn(); const r = res();
    requirePlatformOwner({ user: { email: 'owner@example.com', impersonator: { userId: 'x' } } }, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
  });
  it('refuses a missing user', () => {
    const next = jest.fn(); const r = res();
    requirePlatformOwner({}, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
  });
});
