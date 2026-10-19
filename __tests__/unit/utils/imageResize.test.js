// The server-side image safety net (utils/imageResize.js), with real images
// made by sharp: a phone-sized JPEG with an EXIF rotation and GPS, PNGs with
// and without transparency, WebP, GIF and non-images.

const sharp = require('sharp');
const {
  normalizeImage, normalizeUploadedFiles, renameFor, runLimited, isImageRejected, MAX_EDGE, MAX_INPUT_PIXELS, MAX_CONCURRENT_RESIZES,
} = require('../../../utils/imageResize');
const { pngBomb } = require('../../helpers/imageFixtures');

// A 3200 × 2400 phone photo, stored sideways (EXIF orientation 6) with the
// camera's make and a GPS position.
const phonePhoto = () => sharp({ create: { width: 3200, height: 2400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 12 } } })
  .jpeg({ quality: 80 })
  .withExifMerge({ IFD0: { Make: 'ExamplePhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 39/1 0/1' } })
  .withMetadata({ orientation: 6 })
  .toBuffer();
const solid = (width, height, { alpha = 1, channels = alpha < 1 ? 4 : 3 } = {}) =>
  sharp({ create: { width, height, channels, background: { r: 30, g: 120, b: 200, alpha } } });
const metaOf = (buf) => sharp(buf).metadata();

describe('normalizeImage', () => {
  it('resizes a big phone JPEG to 2000 px, turns it upright and strips its EXIF and GPS', async () => {
    const input = await phonePhoto();
    const before = await metaOf(input);
    expect([before.width, before.height, before.orientation]).toEqual([3200, 2400, 6]);
    expect(before.exif.toString('latin1')).toContain('ExamplePhone');

    const out = await normalizeImage(input, 'image/jpeg');
    expect(out).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg', width: 1500, height: 2000, resized: true });
    const after = await metaOf(out.buffer);
    expect(after.format).toBe('jpeg');
    expect([after.width, after.height]).toEqual([1500, 2000]); // upright: the long edge is the height
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(out.buffer.includes(Buffer.from('ExamplePhone'))).toBe(false);
    expect(out.buffer.length).toBeLessThan(input.length);
  });

  it('keeps a transparent PNG a PNG (resized, alpha kept); an opaque big PNG becomes a JPEG', async () => {
    const clear = await solid(3000, 2400, { alpha: 0.5 }).png().toBuffer();
    const a = await normalizeImage(clear, 'image/png');
    expect(a).toMatchObject({ contentType: 'image/png', ext: 'png', width: 2000, height: 1600 });
    expect((await metaOf(a.buffer)).hasAlpha).toBe(true);

    // An alpha channel that is fully opaque is not transparency.
    const opaque = await solid(3000, 2400, { alpha: 1, channels: 4 }).png().toBuffer();
    const b = await normalizeImage(opaque, 'image/png');
    expect(b).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg', width: 2000, height: 1600 });
  });

  it('a big WebP becomes a JPEG; a transparent one stays WebP', async () => {
    const webp = await sharp({ create: { width: 2600, height: 1300, channels: 3, noise: { type: 'gaussian', mean: 100, sigma: 20 } } }).webp().toBuffer();
    expect(await normalizeImage(webp, 'image/webp')).toMatchObject({ contentType: 'image/jpeg', width: 2000, height: 1000 });
    const clear = await solid(2600, 1300, { alpha: 0.3 }).webp().toBuffer();
    expect(await normalizeImage(clear, 'image/webp')).toMatchObject({ contentType: 'image/webp', width: 2000, height: 1000 });
  });

  it('a file over 1.5 MB is re-encoded even under 2000 px', async () => {
    const heavy = await sharp({ create: { width: 1900, height: 1900, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .png({ compressionLevel: 0 }).toBuffer();
    expect(heavy.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const out = await normalizeImage(heavy, 'image/png');
    expect(out).toMatchObject({ contentType: 'image/jpeg', width: 1900, height: 1900, resized: true });
  });

  it('a small image with metadata is stripped and turned upright in its own format, not resized', async () => {
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#88aacc' } })
      .jpeg().withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 39/1 0/1' } }).withMetadata({ orientation: 6 }).toBuffer();
    const out = await normalizeImage(small, 'image/jpeg');
    expect(out).toMatchObject({ contentType: 'image/jpeg', width: 600, height: 800, resized: false });
    expect((await metaOf(out.buffer)).exif).toBeUndefined();

    const taggedPng = await solid(400, 300).png().withExifMerge({ IFD0: { Make: 'ExamplePhone' } }).toBuffer();
    const png = await normalizeImage(taggedPng, 'image/png');
    expect(png).toMatchObject({ contentType: 'image/png', width: 400, height: 300, resized: false });
    expect((await metaOf(png.buffer)).exif).toBeUndefined();
  });

  it('leaves a small clean image, GIF, HEIC and PDF untouched (null)', async () => {
    const clean = await solid(640, 480).jpeg().toBuffer();
    expect(await normalizeImage(clean, 'image/jpeg')).toBeNull();
    const gif = await solid(3000, 3000).gif().toBuffer();
    expect(await normalizeImage(gif, 'image/gif')).toBeNull();
    expect(await normalizeImage(gif, 'image/png')).toBeNull(); // a GIF named .png stays a GIF
    expect(await normalizeImage(Buffer.from('not really heic'), 'image/heic')).toBeNull();
    expect(await normalizeImage(Buffer.from('%PDF-1.4'), 'application/pdf')).toBeNull();
  });

  it('re-review N2: a tiny file claiming a huge picture is refused at once (400 IMAGE_TOO_LARGE), never decoded', async () => {
    const bomb = pngBomb(20000, 20000);
    expect(bomb.length).toBeLessThan(200);
    const started = Date.now();
    const error = await normalizeImage(bomb, 'image/png', { name: 'diagram.png' }).then(() => null, (e) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(isImageRejected(error)).toBe(true);
    expect(error).toMatchObject({ status: 400, expose: true, code: 'IMAGE_TOO_LARGE' });
    expect(error.message).toBe('"diagram.png" is too large (over 50 megapixels). Make it smaller and try again.');
    // Just over the cap is refused too; a 48 MP phone photo (8064 × 6048) is under it.
    expect(MAX_INPUT_PIXELS).toBe(50_000_000);
    expect((await normalizeImage(pngBomb(7072, 7072), 'image/png').catch((e) => e)).code).toBe('IMAGE_TOO_LARGE');
    expect(8064 * 6048).toBeLessThan(MAX_INPUT_PIXELS);
  });

  it('re-review N2: bytes that are not the image they claim to be are refused (400 IMAGE_UNREADABLE), never a 500', async () => {
    const error = await normalizeImage(Buffer.from('garbage that claims to be a jpeg'), 'image/jpeg').catch((e) => e);
    expect(error).toMatchObject({ status: 400, code: 'IMAGE_UNREADABLE', message: "This image couldn't be read. Try another file." });
    const header = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not a jpeg body '.repeat(40))]);
    expect((await normalizeImage(header, 'image/jpeg').catch((e) => e)).code).toBe('IMAGE_UNREADABLE');
  });

  it('N3: a truncated phone photo is still stripped of its GPS (decoded leniently), not stored as uploaded', async () => {
    const whole = await sharp({ create: { width: 1200, height: 900, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 20 } } })
      .jpeg().withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 39/1 0/1' } }).toBuffer();
    const truncated = whole.subarray(0, Math.floor(whole.length * 0.6));
    expect((await metaOf(truncated)).exif).toBeDefined();
    const out = await normalizeImage(truncated, 'image/jpeg');
    expect(out).toMatchObject({ contentType: 'image/jpeg', width: 1200, height: 900, resized: false });
    expect((await metaOf(out.buffer)).exif).toBeUndefined();
  });

  it('re-review N2: sharp runs single-threaded with its cache off, so one upload is one bounded decode', () => {
    expect(sharp.concurrency()).toBe(1);
    const cache = sharp.cache();
    expect(cache.memory.max).toBe(0);
    expect(cache.items.max).toBe(0);
  });

  it(`never makes an image larger than ${MAX_EDGE} px on its long edge`, async () => {
    const tall = await solid(900, 5000).jpeg().toBuffer();
    const out = await normalizeImage(tall, 'image/jpeg');
    expect(Math.max(out.width, out.height)).toBe(MAX_EDGE);
  });
});

describe('normalizeUploadedFiles', () => {
  it('rewrites each multer file in place: buffer, size, type and name follow the stored image', async () => {
    const photo = await phonePhoto();
    const opaquePng = await solid(3000, 2000).png().toBuffer();
    const pdf = Buffer.from('%PDF-1.4 worksheet');
    const files = [
      { originalname: 'IMG_0042.JPG', mimetype: 'image/jpeg', buffer: photo, size: photo.length },
      { originalname: 'Screenshot.PNG', mimetype: 'image/png', buffer: opaquePng, size: opaquePng.length },
      { originalname: 'worksheet.pdf', mimetype: 'application/pdf', buffer: pdf, size: pdf.length },
    ];
    await normalizeUploadedFiles(files);
    expect(files[0]).toMatchObject({ originalname: 'IMG_0042.JPG', mimetype: 'image/jpeg' });
    expect(files[0].size).toBe(files[0].buffer.length);
    expect(files[0].size).toBeLessThan(photo.length);
    expect(files[1]).toMatchObject({ originalname: 'Screenshot.jpg', mimetype: 'image/jpeg' });
    expect(files[2]).toMatchObject({ originalname: 'worksheet.pdf', mimetype: 'application/pdf', buffer: pdf, size: pdf.length });
  });

  it('re-review N2: a refused image stops the batch with that file named; nothing after it is decoded', async () => {
    const photo = await phonePhoto();
    const files = [
      { originalname: 'ok.jpg', mimetype: 'image/jpeg', buffer: photo, size: photo.length },
      { originalname: 'bomb.png', mimetype: 'image/png', buffer: pngBomb(), size: 74 },
    ];
    const error = await normalizeUploadedFiles(files).catch((e) => e);
    expect(error).toMatchObject({ status: 400, code: 'IMAGE_TOO_LARGE' });
    expect(error.message).toContain('"bomb.png"');
  });

  it('renameFor swaps the extension only when the type changed', () => {
    expect(renameFor('a.png', 'jpg')).toBe('a.jpg');
    expect(renameFor('a.jpeg', 'jpg')).toBe('a.jpeg');
    expect(renameFor('a.JPG', 'jpg')).toBe('a.JPG');
    expect(renameFor('noext', 'jpg')).toBe('noext.jpg');
    expect(renameFor('a.webp', 'webp')).toBe('a.webp');
  });
});

describe('runLimited (the upload resize queue)', () => {
  it(`runs at most ${MAX_CONCURRENT_RESIZES} jobs at once, in order, passing results and errors through`, async () => {
    expect(MAX_CONCURRENT_RESIZES).toBe(2);
    let running = 0;
    let peak = 0;
    const order = [];
    const job = (n, fail = false) => () => new Promise((resolve, reject) => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(n);
      setTimeout(() => {
        running -= 1;
        if (fail) reject(new Error(`job ${n} failed`));
        else resolve(n * 10);
      }, 15);
    });
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => runLimited(job(n, n === 3))));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message)))
      .toEqual([10, 20, 'job 3 failed', 40, 50, 60]);
    // A job that throws synchronously frees its slot too.
    await expect(runLimited(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    await expect(runLimited(async () => 'next')).resolves.toBe('next');
  });
});

describe('without sharp', () => {
  it('a server whose sharp binary failed to load still boots and stores uploads unchanged', async () => {
    const input = await phonePhoto();
    let mod;
    jest.isolateModules(() => {
      jest.doMock('sharp', () => { throw new Error('Could not load the "sharp" module'); });
      mod = require('../../../utils/imageResize');
    });
    expect(await mod.normalizeImage(input, 'image/jpeg')).toBeNull();
    const files = [{ originalname: 'a.jpg', mimetype: 'image/jpeg', buffer: input, size: input.length }];
    await mod.normalizeUploadedFiles(files);
    expect(files[0].buffer).toBe(input);
    jest.dontMock('sharp');
  });
});
