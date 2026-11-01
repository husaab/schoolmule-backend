/**
 * vendor/reportkit is generated from the web repo (npm run sync:reportkit).
 * These checks catch a hand-edited or half-committed copy: the bundle must
 * match its manifest, and every font the engine asks for must be shipped.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDOR = path.join(__dirname, '..', '..', '..', '..', 'vendor', 'reportkit');

describe('vendor/reportkit', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'manifest.json'), 'utf8'));
  const code = fs.readFileSync(path.join(VENDOR, 'reportkit.iife.js'), 'utf8');

  it('the bundle is exactly the one its manifest describes', () => {
    const sha = crypto.createHash('sha256').update(code).digest('hex');
    expect(sha).toBe(manifest.bundleSha256);
  });

  it('carries an engine version (stamped on every generated report)', () => {
    expect(Number.isInteger(manifest.engineVersion)).toBe(true);
    expect(manifest.engineVersion).toBeGreaterThan(0);
    expect(manifest.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ships every built-in image the engine offers, and the printer inlines the ones a template uses', () => {
    const { reportKit, builtinImageUris } = require('../../../../services/reportEngine/render');
    const names = reportKit().BUILTIN_IMAGES.map((b) => b.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !fs.existsSync(path.join(VENDOR, 'assets', n)))).toEqual([]);

    const uris = builtinImageUris({ blocks: [{ type: 'canvas', elements: [{ type: 'image', src: { kind: 'builtin', name: 'jk-banner.jpg' } }, { type: 'image', src: { kind: 'builtin', name: 'nope.png' } }] }] });
    expect(Object.keys(uris)).toEqual(['jk-banner.jpg']);
    expect(uris['jk-banner.jpg']).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('ships every font file the engine references', () => {
    const { reportKit } = require('../../../../services/reportEngine/render');
    const missing = reportKit().fontFiles().filter((f) => !fs.existsSync(path.join(VENDOR, 'fonts', f)));
    expect(missing).toEqual([]);
  });
});
