const { AI_MODEL, chatBody, withoutRefused, openaiChat } = require('../../../services/openaiChat');

const messages = [{ role: 'user', content: 'Hello' }];
const answer = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (param) =>
  answer(400, { error: { message: `Unsupported parameter: '${param}'`, param, code: 'unsupported_parameter' } });
const sentBodies = () => global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));

describe('openaiChat', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('chatBody', () => {
    it('uses the replacement for gpt-4o-mini by default', () => {
      expect(AI_MODEL).toBe('gpt-6-luna');
      expect(chatBody({ messages, maxTokens: 220 }).model).toBe('gpt-6-luna');
    });

    it('switches thinking off and names the output limit the newer way', () => {
      expect(chatBody({ messages, maxTokens: 220, temperature: 0.6 })).toEqual({
        model: 'gpt-6-luna',
        messages,
        max_completion_tokens: 220,
        reasoning_effort: 'none',
        temperature: 0.6,
      });
    });

    it('keeps the old request shape for a gpt-4 model', () => {
      expect(chatBody({ messages, maxTokens: 220, temperature: 0.6, model: 'gpt-4o-mini' })).toEqual({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 220,
        temperature: 0.6,
      });
    });
  });

  describe('withoutRefused', () => {
    const body = { model: 'm', messages, max_completion_tokens: 50, reasoning_effort: 'none', temperature: 0.7 };

    it('drops a refused temperature or thinking setting', () => {
      expect(withoutRefused(body, 'temperature')).not.toHaveProperty('temperature');
      expect(withoutRefused(body, 'reasoning_effort')).not.toHaveProperty('reasoning_effort');
    });

    it('renames the output limit either way, keeping its value', () => {
      expect(withoutRefused(body, 'max_completion_tokens')).toMatchObject({ max_tokens: 50 });
      expect(withoutRefused({ model: 'm', max_tokens: 50 }, 'max_tokens')).toEqual({ model: 'm', max_completion_tokens: 50 });
    });

    it('changes nothing for a setting it does not send or does not know', () => {
      expect(withoutRefused(body, 'messages')).toBeNull();
      expect(withoutRefused(body, 'top_p')).toBeNull();
      expect(withoutRefused(body, null)).toBeNull();
    });
  });

  describe('the request', () => {
    it('is posted once with the key, and the response returned untouched', async () => {
      const ok = answer(200, { choices: [{ message: { content: 'Hi' } }] });
      global.fetch = jest.fn().mockResolvedValue(ok);

      const response = await openaiChat('sk-test', { messages, maxTokens: 50, temperature: 0.7 });

      expect(response).toBe(ok);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(init.headers.Authorization).toBe('Bearer sk-test');
    });

    it('is sent again without a setting the API refuses', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(refusal('temperature'))
        .mockResolvedValueOnce(answer(200, { choices: [] }));

      const response = await openaiChat('sk-test', { messages, maxTokens: 50, temperature: 0.7 });

      expect(response.status).toBe(200);
      const [first, second] = sentBodies();
      expect(first.temperature).toBe(0.7);
      expect(second).not.toHaveProperty('temperature');
      expect(second.max_completion_tokens).toBe(50);
    });

    it('stops after two adjustments and returns the refusal', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(refusal('temperature'))
        .mockResolvedValueOnce(refusal('reasoning_effort'))
        .mockResolvedValueOnce(refusal('max_completion_tokens'));

      const response = await openaiChat('sk-test', { messages, maxTokens: 50, temperature: 0.7 });

      expect(response.status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('is not retried for a 400 about something else, or for any other failure', async () => {
      global.fetch = jest.fn().mockResolvedValue(answer(400, { error: { message: 'Bad messages', param: 'messages' } }));
      expect((await openaiChat('sk-test', { messages, maxTokens: 50 })).status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      global.fetch = jest.fn().mockResolvedValue(answer(429, { error: { message: 'Slow down' } }));
      expect((await openaiChat('sk-test', { messages, maxTokens: 50 })).status).toBe(429);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
