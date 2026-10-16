const express = require('express');
const request = require('supertest');
const { sniffImageType, singleImage, EXT_BY_TYPE } = require('../../../utils/imageUpload');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

describe('imageUpload: sniffImageType', () => {
  it('recognises JPEG, PNG and WebP from their first bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses everything else, including too-short buffers and non-buffers', () => {
    expect(sniffImageType(Buffer.from('GIF89a' + 'x'.repeat(20)))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7' + 'x'.repeat(20)))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF....WAVE' + 'x'.repeat(8)))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
    expect(sniffImageType(null)).toBeNull();
    expect(sniffImageType('PNG')).toBeNull();
  });

  it('maps each type to its extension', () => {
    expect(EXT_BY_TYPE).toEqual({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
  });
});

describe('imageUpload: singleImage', () => {
  const app = express();
  app.post('/up', singleImage({ field: 'pic', maxBytes: 100 }), (req, res) => res.json({ ok: true, image: { ...req.image, buffer: req.image.buffer.length } }));
  const server = app.listen(0, '127.0.0.1');
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  const post = () => request(server).post('/up');

  it('hands the sniffed type and extension to the route, whatever the file is called', async () => {
    const res = await post().attach('pic', PNG, { filename: 'whatever.jpg', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.image).toEqual({ buffer: PNG.length, contentType: 'image/png', ext: 'png', size: PNG.length });
  });

  it('answers 400 in the envelope for a missing file, a wrong declared type, a disguised file and a wrong field', async () => {
    const none = await post().send({});
    expect(none.status).toBe(400);
    expect(none.body).toEqual({ status: 'failed', message: 'Choose an image to upload' });

    const gif = await post().attach('pic', Buffer.from('GIF89a'), { filename: 'a.gif', contentType: 'image/gif' });
    expect(gif.status).toBe(400);
    expect(gif.body.message).toBe('Use a JPEG, PNG or WebP image');

    const disguised = await post().attach('pic', Buffer.from('definitely not a picture'), { filename: 'a.png', contentType: 'image/png' });
    expect(disguised.status).toBe(400);

    const wrongField = await post().attach('other', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.message).toContain('"pic"');
  });

  it('accepts exactly maxBytes and refuses one byte more', async () => {
    const at = await post().attach('pic', Buffer.concat([PNG, Buffer.alloc(100 - PNG.length)]), { filename: 'a.png', contentType: 'image/png' });
    expect(at.status).toBe(200);
    const over = await post().attach('pic', Buffer.concat([PNG, Buffer.alloc(101 - PNG.length)]), { filename: 'a.png', contentType: 'image/png' });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/smaller/);
  });
});
