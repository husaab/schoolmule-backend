// services/assistant/transcribe.js
//
// Muley's microphone: a short recording becomes text in the composer, which
// the person reads (and can fix) before sending. The audio goes to OpenAI's
// transcription endpoint and is not kept by SchoolMule. The model is
// ASSISTANT_TRANSCRIBE_MODEL (default gpt-transcribe; OpenAI's older
// transcription models stop on 2027-02-26).

const logger = require('../../logger');

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
// Words a school says that a general model would spell wrong.
const KEYWORDS = ['Muley', 'School Mule', 'gradebook', 'report card', 'progress report', 'PA day'];

// What a recording may be, by the type the browser or phone gives it (the endpoint takes these containers).
const TYPES = Object.freeze({
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
});

const model = () => process.env.ASSISTANT_TRANSCRIBE_MODEL || 'gpt-transcribe';

/** The extension for a recording's type, or null when it isn't one the endpoint takes. */
const extensionFor = (mimetype) => TYPES[String(mimetype || '').split(';')[0].trim().toLowerCase()] || null;

class TranscribeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function send(apiKey, { buffer, mimetype, ext }, withKeywords) {
  const form = new FormData();
  form.append('model', model());
  form.append('file', new Blob([buffer], { type: String(mimetype).split(';')[0] }), `recording.${ext}`);
  if (withKeywords) for (const word of KEYWORDS) form.append('keywords[]', word);
  return fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Turn a recording into text. -> { text, usage } (usage when OpenAI reports it).
 * Throws a TranscribeError the route answers with as is.
 */
async function transcribe({ buffer, mimetype }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TranscribeError(503, 'unavailable', "Voice isn't available right now. Type your message instead.");
  const ext = extensionFor(mimetype);
  if (!ext) throw new TranscribeError(400, 'AUDIO_TYPE', "That recording couldn't be read. Try again, or type your message.");
  if (!buffer || buffer.length === 0) throw new TranscribeError(400, 'AUDIO_EMPTY', 'Nothing was recorded. Try again.');
  if (buffer.length > MAX_BYTES) throw new TranscribeError(400, 'AUDIO_TOO_LONG', 'That recording is too long. Keep it under two minutes.');

  let res;
  try {
    res = await send(apiKey, { buffer, mimetype, ext }, true);
    if (res.status === 400) {
      // A model that doesn't take keywords is asked again without them.
      const body = await res.clone().json().catch(() => ({}));
      if (body && body.error && /keyword/i.test(`${body.error.param || ''} ${body.error.message || ''}`)) res = await send(apiKey, { buffer, mimetype, ext }, false);
    }
  } catch (err) {
    logger.warn({ err }, 'Assistant: transcription request failed');
    throw new TranscribeError(503, 'unavailable', "Your recording couldn't be turned into text just now. Try again, or type your message.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logger.warn({ status: res.status, error: body && body.error ? body.error.message : null }, 'Assistant: transcription refused');
    throw new TranscribeError(res.status === 429 ? 429 : 502, 'TRANSCRIBE_FAILED', "Your recording couldn't be turned into text just now. Try again, or type your message.");
  }
  const data = await res.json().catch(() => ({}));
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  return { text, usage: data.usage || null };
}

module.exports = { transcribe, extensionFor, TranscribeError, MAX_BYTES, KEYWORDS };
