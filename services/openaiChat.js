// services/openaiChat.js
//
// The one place the backend names an OpenAI model and builds a Chat
// Completions request (the web app has the same helper for its AI routes:
// schoolmule/src/lib/server/openaiChat.ts). A model change is one line here,
// or the OPENAI_MODEL variable.
//
// OpenAI retires gpt-4o-mini on 14 January 2027 and names gpt-6-luna as its
// replacement. The newer models think before answering by default, and that
// thinking is billed against the same output limit as the answer: with a
// short limit the answer could come back empty. These are one-shot writing
// tasks, so thinking is switched off.
//
// Which of the older request settings a model accepts changes between model
// generations (`max_tokens` became `max_completion_tokens`; some models take
// `temperature` only at its default). A setting the API refuses by name is
// swapped or dropped and the request sent again, so a rename upstream costs
// a retry and not the feature.

const logger = require('../logger');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

/** The gpt-4 family: no thinking, and the older name for the output limit. */
const isLegacyModel = (model) => model.startsWith('gpt-4');

/** The request body for these options, in the shape the model expects. */
function chatBody({ messages, maxTokens, temperature, model = AI_MODEL }) {
  const body = { model, messages };
  if (isLegacyModel(model)) {
    body.max_tokens = maxTokens;
  } else {
    body.max_completion_tokens = maxTokens;
    body.reasoning_effort = 'none';
  }
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

const without = (body, key) => {
  const rest = { ...body };
  delete rest[key];
  return rest;
};

/** The same request without the setting the API refused, or null when there is nothing to change. */
function withoutRefused(body, refused) {
  if (!refused || !(refused in body)) return null;
  if (refused === 'max_tokens') return { ...without(body, 'max_tokens'), max_completion_tokens: body.max_tokens };
  if (refused === 'max_completion_tokens') return { ...without(body, 'max_completion_tokens'), max_tokens: body.max_completion_tokens };
  if (refused === 'temperature' || refused === 'reasoning_effort') return without(body, refused);
  return null;
}

/** The setting a 400 answer names (`error.param`), if it names one. */
async function refusedSetting(response) {
  try {
    const data = await response.clone().json();
    return typeof data?.error?.param === 'string' ? data.error.param : null;
  } catch {
    return null;
  }
}

/** POST the chat request and return OpenAI's response as is. */
async function openaiChat(apiKey, options) {
  let body = chatBody(options);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (response.status !== 400 || attempt >= 2) return response;
    const refused = await refusedSetting(response);
    const adjusted = withoutRefused(body, refused);
    if (!adjusted) return response;
    logger.warn({ model: body.model, refused }, 'OpenAI refused a request setting; sending the request again without it');
    body = adjusted;
  }
}

module.exports = { AI_MODEL, chatBody, withoutRefused, openaiChat };
