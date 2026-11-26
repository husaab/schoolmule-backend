// A scripted stand-in for the model, so no test ever calls a real one.
//
//   const provider = fakeProvider([
//     [toolCall('list_classes', {})],          // the model's first answer
//     [text('You teach two classes.')],        // its second, after the tool ran
//   ]);
//   require('.../services/assistant/provider').__setAdapterForTests(provider);
//
// A step may be a function of the request, to answer from what it was sent.
// provider.calls holds every request, so a test can assert what the model
// was shown (and what it never was).

let nextId = 0;

const text = (content) => ({ type: 'text', delta: content });
const toolCall = (name, args = {}, id) => ({ type: 'tool_call', id: id || `call_${(nextId += 1)}`, name, args: JSON.stringify(args) });
const usage = (input = 100, output = 20, cachedInput = 0) => ({ type: 'usage', input, cachedInput, output });

function fakeProvider(script) {
  const calls = [];
  let step = 0;
  return {
    calls,
    /** Everything any request showed the model, as one string. */
    seen: () => JSON.stringify(calls),
    async *stream(request) {
      calls.push(JSON.parse(JSON.stringify({ model: request.model, system: request.system, messages: request.messages, tools: request.tools })));
      const next = script[step];
      step += 1;
      if (next === undefined) throw new Error(`fakeProvider: the script has no step ${step}`);
      if (next instanceof Error) throw next;
      const events = typeof next === 'function' ? next(request, calls) : next;
      let called = false;
      for (const event of events) {
        if (event.type === 'tool_call') called = true;
        yield event;
      }
      if (!events.some((e) => e.type === 'usage')) yield usage();
      yield { type: 'finish', reason: called ? 'tool_calls' : 'stop' };
    },
  };
}

module.exports = { fakeProvider, text, toolCall, usage };
