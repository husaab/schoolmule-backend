// services/assistant/provider/openaiAdapter.js
//
// The one module that knows how OpenAI's API is shaped. The rest of Muley
// speaks a neutral format (below), so the transcript in the database stays
// readable whatever model or provider answers next.
//
//   system    [string, ...]  operator instructions; the static part first
//   messages  [{ role: 'user', content }
//              { role: 'assistant', content?, toolCalls?: [{ id, name, args }] }   args is a JSON string
//              { role: 'tool', toolCallId, content }                              content is a JSON string
//              { role: 'event', content }]                                        something the app did
//   tools     [{ name, description, parameters }]
//
//   stream() yields  { type: 'text', delta }
//                    { type: 'tool_call', id, name, args }
//                    { type: 'usage', input, cachedInput, output }
//                    { type: 'finish', reason: 'stop' | 'tool_calls' | 'length' }
//   and throws a ProviderError.
//
// Uses the Responses API (what OpenAI recommends for tool calling on current
// models) with store: false, so OpenAI keeps no copy of the conversation:
// the whole history is sent each time from our own database. Thinking is off
// by default (config.reasoningEffort), which also means there are no
// reasoning items to carry between calls.

const { ProviderError } = require('../errors');

const ENDPOINT = 'https://api.openai.com/v1/responses';

/** The neutral conversation as Responses API input items. */
function toInput(system, messages) {
  const input = system.filter(Boolean).map((content) => ({ role: 'developer', content }));
  for (const message of messages) {
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content || '' });
    } else if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args || '{}' });
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content || '' });
    } else if (message.role === 'event') {
      input.push({ role: 'developer', content: message.content || '' });
    }
  }
  return input;
}

const toTools = (tools) => tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters, strict: true }));

function errorFor(status, detail) {
  const message = `OpenAI answered ${status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
  if (status === 401 || status === 403) return new ProviderError('auth', message, { status });
  if (status === 429) return new ProviderError('rate_limit', message, { status, retryable: true });
  if (status >= 500) return new ProviderError('overloaded', message, { status, retryable: true });
  return new ProviderError('invalid_request', message, { status });
}

/** Server-sent events from a fetch body, one { event, data } at a time. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = null;
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length === 0) continue;
      try {
        yield { event, data: JSON.parse(data.join('\n')) };
      } catch {
        // a frame that isn't JSON carries nothing we act on
      }
    }
  }
}

/**
 * @param {{ apiKey: string, model: string, system: string[], messages: object[], tools: object[],
 *   maxOutputTokens: number, reasoningEffort?: string, cacheKey?: string, signal?: AbortSignal }} request
 */
async function* stream({ apiKey, model, system, messages, tools, maxOutputTokens, reasoningEffort = 'none', cacheKey, signal }) {
  const body = {
    model,
    input: toInput(system, messages),
    store: false,
    stream: true,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: reasoningEffort },
  };
  if (tools && tools.length > 0) {
    body.tools = toTools(tools);
    body.parallel_tool_calls = true;
  }
  if (cacheKey) body.prompt_cache_key = cacheKey;

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw new ProviderError('aborted', 'The request was stopped');
    throw new ProviderError('failed', `OpenAI could not be reached: ${err.message}`, { retryable: true });
  }
  if (!response.ok || !response.body) {
    const detail = await response.json().then((data) => data?.error?.message).catch(() => null);
    throw errorFor(response.status, detail);
  }

  let sawToolCall = false;
  try {
    for await (const { event, data } of sseEvents(response.body)) {
      if (event === 'response.output_text.delta' && data.delta) {
        yield { type: 'text', delta: data.delta };
      } else if (event === 'response.output_item.done' && data.item?.type === 'function_call') {
        sawToolCall = true;
        yield { type: 'tool_call', id: data.item.call_id, name: data.item.name, args: data.item.arguments || '{}' };
      } else if (event === 'response.completed' || event === 'response.incomplete') {
        const usage = data.response?.usage || {};
        yield {
          type: 'usage',
          input: usage.input_tokens || 0,
          cachedInput: usage.input_tokens_details?.cached_tokens || 0,
          output: usage.output_tokens || 0,
        };
        yield { type: 'finish', reason: event === 'response.incomplete' ? 'length' : sawToolCall ? 'tool_calls' : 'stop' };
        return;
      } else if (event === 'response.failed' || event === 'error') {
        const detail = data.response?.error?.message || data.message || data.error?.message;
        throw new ProviderError('failed', `OpenAI stopped the answer${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw new ProviderError('aborted', 'The request was stopped');
    throw new ProviderError('failed', `The answer was cut off: ${err.message}`);
  }
  // The stream ended without saying it was complete.
  throw new ProviderError('failed', 'The answer ended early');
}

module.exports = { stream, toInput, toTools, sseEvents };
