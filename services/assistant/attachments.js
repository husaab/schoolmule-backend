// services/assistant/attachments.js
//
// Images a person attaches in Muley's panel (a new school stamp, logo or
// signature). Kept in the private school-assets-history bucket, in a folder
// of their own: <school>/muley-uploads/<userId>/<id>. The id is a random
// uuid with the file's extension, and the folder comes from the signed-in
// person, never from the request, so one person can't name another's file.
//
// Nothing is changed by an upload. A change tool can offer to make the file
// a school asset; the school-assets route does that when the person presses
// Save, through the same permission checks as an upload on School Assets.

const { v4: uuidv4 } = require('uuid');
const supabase = require('../../config/supabaseClient');

const BUCKET = 'school-assets-history';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif' });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif)$/;
const CONTENT_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };
const PREVIEW_SECONDS = 60 * 60;

const isId = (id) => typeof id === 'string' && ID_RE.test(id);

/** Where this person's file lives. Throws on an id that isn't one this code made. */
function pathOf(who, id) {
  if (!isId(id)) throw new Error('Not an attachment id');
  return `${who.school}/muley-uploads/${who.userId}/${id}`;
}

/** Keep an uploaded image for this person. -> { id, name, size } */
async function store(who, { buffer, mimetype, originalname }) {
  const ext = TYPES[mimetype];
  if (!ext) throw Object.assign(new Error('Attach a PNG, JPEG or GIF image.'), { status: 400, code: 'FILE_TYPE' });
  if (!buffer || buffer.length === 0) throw Object.assign(new Error('That file is empty.'), { status: 400, code: 'FILE_EMPTY' });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Keep the image under 5 MB.'), { status: 400, code: 'FILE_TOO_LARGE' });
  const id = `${uuidv4()}${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(pathOf(who, id), buffer, { contentType: CONTENT_TYPE[ext], upsert: false });
  if (error) throw new Error(`The image could not be kept: ${error.message || 'storage error'}`);
  const name = String(originalname || `image${ext}`).replace(/[\r\n]/g, ' ').slice(0, 120);
  return { id, name, size: buffer.length };
}

/** The file's bytes, for the school-assets route. Throws when it isn't there. */
async function read(who, id) {
  const { data, error } = await supabase.storage.from(BUCKET).download(pathOf(who, id));
  if (error || !data) throw Object.assign(new Error('That attachment is no longer there. Attach the image again.'), { status: 404, code: 'ATTACHMENT_GONE' });
  const ext = id.slice(id.lastIndexOf('.'));
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: CONTENT_TYPE[ext], ext };
}

/** A short-lived link to show the image in a preview, or null when it isn't there. */
async function previewUrl(who, id) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(pathOf(who, id), PREVIEW_SECONDS);
  return error || !data ? null : data.signedUrl;
}

/** The public link of a live school asset (the school-assets bucket is public). */
function liveUrl(livePath) {
  if (!livePath) return null;
  const { data } = supabase.storage.from('school-assets').getPublicUrl(livePath);
  return data ? data.publicUrl : null;
}

module.exports = { store, read, previewUrl, liveUrl, isId, pathOf, MAX_BYTES, TYPES };
