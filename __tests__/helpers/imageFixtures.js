// Images for the upload tests.
// - TINY_PNG, TINY_JPEG, TINY_WEBP: real 1 × 1 images with no metadata. The
//   server decodes every JPEG, PNG and WebP it is sent and refuses one it
//   can't read (re-review N2), so a test that uploads "an image" sends a real
//   one; these are small and clean, so they are stored byte for byte.
// - pngBomb(): a decompression bomb, a valid PNG header that claims a huge
//   picture in a file of under 100 bytes. A decoder that trusted it would
//   allocate width × height × 4 bytes (20000² is 1.6 GB) before noticing the
//   pixel data is missing.

const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGBA PNG whose header says `width` × `height`, with almost no pixel data. */
function pngBomb(width = 20000, height = 20000) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(1000))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR42mMwTpsJAAICATNoejH4AAAAAElFTkSuQmCC',
  'base64',
);

const TINY_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYa'
  + 'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA'
  + 'AAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAAnHX/2Q==',
  'base64',
);

const TINY_WEBP = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoBAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==', 'base64');

module.exports = { pngBomb, TINY_PNG, TINY_JPEG, TINY_WEBP };
