// services/push/expoClient.js
//
// The Expo Push API over plain fetch: send up to 100 messages a request and
// read the delivery receipts. With "enhanced push security" on in EAS, every
// request carries EXPO_ACCESS_TOKEN (a server secret, never in the app).

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const BATCH = 100;
const RECEIPT_BATCH = 1000;
const TIMEOUT_MS = 10_000;

/** A request Expo didn't take; the messages in it may be retried. */
class ExpoTransportError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ExpoTransportError';
    this.status = status;
  }
}

async function post(url, body) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new ExpoTransportError(`Expo push request failed: ${error.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    const detail = json?.errors?.map((e) => e.code || e.message).join(', ') || res.statusText;
    throw new ExpoTransportError(`Expo push answered ${res.status}: ${detail}`, res.status);
  }
  return json.data;
}

/**
 * Sends one request of at most 100 messages.
 * @returns {Promise<Array<{ status: 'ok'|'error', id?: string, message?: string, details?: { error?: string } }>>}
 *   one ticket per message, in order. Throws ExpoTransportError when the request fails.
 */
async function sendBatch(messages) {
  if (messages.length > BATCH) throw new Error(`Expo takes at most ${BATCH} messages a request`);
  return post(SEND_URL, messages);
}

/** Receipts for ticket ids: { [id]: { status, message?, details? } }; missing ids have none yet. */
async function getReceipts(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
    Object.assign(out, await post(RECEIPTS_URL, { ids: ids.slice(i, i + RECEIPT_BATCH) }));
  }
  return out;
}

module.exports = { sendBatch, getReceipts, ExpoTransportError, BATCH };
