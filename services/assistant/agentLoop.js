// services/assistant/agentLoop.js
//
// One turn of a conversation with Muley: the person's message goes to the
// model with the tools their view gets; each tool the model calls is run
// (reading through the backend's own routes with the person's token) and its
// answer handed back; this repeats until the model answers in words, asks
// the person to choose, or a cap is reached.
//
// Everything the person sees goes out through `emit` as it happens (text,
// what a tool is doing, cards, choices). Everything is stored as it
// completes, so a dropped connection loses nothing that was already done.
//
// Nothing here writes school data: tools can only read.

const config = require('./config');
const store = require('./store');
const registry = require('./tools');
const aiUsage = require('../aiUsage');
const logger = require('../../logger');
const { Refs } = require('./refs');
const { createDispatcher } = require('./tools/dispatcher');
const { getAdapter } = require('./provider');
const { assemble, todayIn } = require('./prompt/assemble');
const { ProviderError, ToolError } = require('./errors');
const { scrubText } = require('./tools/shape/scrub');
const actions = require('./actions/service');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored transcript as the adapter takes it, cut to a recent window that starts on a person's message. */
function recent(transcript, limit) {
  let start = Math.max(0, transcript.length - limit);
  while (start < transcript.length && transcript[start].role !== 'user') start += 1;
  return transcript.slice(start).map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls || undefined,
    toolCallId: m.toolCallId || undefined,
  }));
}

/** The class the person is looking at, when their account can open it: checked with a real, guarded read. */
async function pageOf(pageContext, read, refs) {
  const route = pageContext && typeof pageContext.route === 'string' ? pageContext.route : '';
  // The school's daily attendance page: no class, but it says which attendance "attendance" means.
  if (/^\/attendance\/general(?:\/|$)/.test(route)) return { label: 'Daily attendance', dailyAttendance: true };
  const classId = pageContext && typeof pageContext.classId === 'string' && UUID_RE.test(pageContext.classId) ? pageContext.classId : null;
  if (!classId) return null;
  try {
    const { data } = await read('class', { params: { classId } });
    if (!data) return null;
    const label = `${data.subject} · Grade ${data.grade}`;
    return { label, classRef: refs.mint('class', data.classId, label) };
  } catch {
    return null; // not theirs, or gone: the page tells Muley nothing
  }
}

const MESSAGES = {
  unavailable: "Muley can't answer right now. Try again in a moment.",
  busy: 'Muley is busy right now. Try again in a moment.',
  limit: 'That took more steps than one request allows. Try asking for a smaller piece.',
  cut: 'The answer was cut short. Ask again, or ask for less at once.',
};

/**
 * @param {{ who: {userId: string, view: string, school: string}, access: object, token: string,
 *   schoolYear: {schoolYearId: string, label: string}|null, conversation: object, turnId: string,
 *   text: string, choice?: {label: string, ref: string|null}|null, pageContext?: object|null,
 *   emit: (event: object) => void, signal: AbortSignal }} turn
 * @returns {Promise<'end'|'choices'|'limit'|'error'|'aborted'>} why the turn ended
 */
async function runTurn({ who, access, token, schoolYear, conversation, turnId, text: typed, choice = null, attached = [], pageContext = null, allowWrites = false, emit, signal }) {
  const caps = config.caps();
  // Anything shaped like an education number is taken out of what the person
  // typed before it is stored or sent to the model.
  const text = scrubText(typed);
  const refs = new Refs(conversation.refs);
  const { read } = createDispatcher({ token, schoolYearId: schoolYear ? schoolYear.schoolYearId : null, requestId: turnId });
  const today = todayIn(config.timezone());
  const view = who.view;
  const usageOf = (usage) => aiUsage.record({ school: who.school, userId: who.userId, feature: 'assistant', inputTokens: usage.input, cachedInputTokens: usage.cachedInput, outputTokens: usage.output });

  try {
    const [history, firstName, page] = await Promise.all([
      store.transcript(conversation.id),
      store.firstNameOf(who.userId),
      view === 'PARENT' ? null : pageOf(pageContext, read, refs),
    ]);
    const messages = recent(history, caps.historyMessages);
    // The panel's "On this page: …": only a class this person can open.
    emit({ t: 'context', label: page ? page.label : null });

    await store.append(conversation.id, turnId, { role: 'user', content: text });
    messages.push({ role: 'user', content: text });
    if (choice && choice.ref) {
      // What the person tapped, told to the model in the app's own voice: the ref never appears in their words.
      const picked = refs.resolve(choice.ref);
      const note = `The person chose "${picked.label}" (ref ${choice.ref}).`;
      await store.append(conversation.id, turnId, { role: 'event', content: note });
      messages.push({ role: 'event', content: note });
    }
    if (attached.length > 0) {
      // The model never sees the image itself: its name and a ref a tool can take.
      const named = attached.map((f) => `"${f.name}" (ref ${refs.mint('file', f.id, f.name)})`);
      const note = `The person attached ${attached.length === 1 ? 'an image' : `${attached.length} images`}: ${named.join(', ')}. You can't see images; use the ref with a tool that takes a file.`;
      await store.append(conversation.id, turnId, { role: 'event', content: note });
      messages.push({ role: 'event', content: note });
    }

    const system = assemble({ firstName, view, access, schoolYearLabel: schoolYear ? schoolYear.label : null, today, page, allowWrites });
    const tools = registry.definitionsFor(view, { allowWrites });
    const offered = new Set(tools.map((tool) => tool.name));
    // offers(name): whether this conversation has that tool (a change tool only where the school allows changes).
    const baseCtx = { read, refs, access, user: { userId: who.userId, school: who.school }, today: today.date, pageContext: page, offers: (name) => offered.has(name) };
    // A tool that prepares a change records it here; nothing is written to school data.
    const contextFor = (toolCallId) => ({
      ...baseCtx,
      propose: (proposal) => actions.create({ ...proposal, conversationId: conversation.id, toolCallId, who, schoolYearId: schoolYear ? schoolYear.schoolYearId : null }),
    });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('OPENAI_API_KEY is not set on the backend: the assistant cannot answer');
      emit({ t: 'error', code: 'unavailable', message: MESSAGES.unavailable, retryable: true });
      return 'error';
    }

    let toolRuns = 0;
    for (let call = 0; call < caps.providerCalls; call += 1) {
      let answer = '';
      let usage = null;
      let finish = 'stop';
      const toolCalls = [];

      for (let attempt = 0; ; attempt += 1) {
        try {
          const stream = getAdapter().stream({
            apiKey, model: config.model(), system, messages, tools,
            maxOutputTokens: caps.maxOutputTokens, reasoningEffort: config.reasoningEffort(),
            cacheKey: `muley:${who.school}:${view}`, signal,
          });
          for await (const event of stream) {
            if (event.type === 'text') {
              answer += event.delta;
              emit({ t: 'text', d: event.delta });
            } else if (event.type === 'tool_call') {
              toolCalls.push({ id: event.id, name: event.name, args: event.args });
            } else if (event.type === 'usage') {
              usage = { input: event.input, cachedInput: event.cachedInput, output: event.output };
            } else if (event.type === 'finish') {
              finish = event.reason;
            }
          }
          break;
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          if (err.kind === 'aborted' || signal.aborted) {
            if (answer) await store.append(conversation.id, turnId, { role: 'assistant', content: answer, model: config.model() });
            return 'aborted';
          }
          // Once only, and only if the person has seen nothing of this answer yet.
          if (err.retryable && attempt === 0 && !answer && toolCalls.length === 0) continue;
          logger.error({ err, kind: err.kind, status: err.status }, 'Assistant: the model request failed');
          if (answer) await store.append(conversation.id, turnId, { role: 'assistant', content: answer, model: config.model() });
          emit({ t: 'error', code: err.kind === 'rate_limit' ? 'busy' : 'unavailable', message: err.kind === 'rate_limit' ? MESSAGES.busy : MESSAGES.unavailable, retryable: true });
          return 'error';
        }
      }

      await store.append(conversation.id, turnId, {
        role: 'assistant', content: answer || null, toolCalls: toolCalls.length ? toolCalls : null, model: config.model(), usage,
      });
      messages.push({ role: 'assistant', content: answer || null, toolCalls: toolCalls.length ? toolCalls : undefined });
      if (usage) {
        await usageOf(usage);
        emit({ t: 'usage', in: usage.input, cachedIn: usage.cachedInput, out: usage.output });
      }

      if (toolCalls.length === 0) {
        if (finish === 'length') emit({ t: 'error', code: 'cut', message: MESSAGES.cut, retryable: true });
        return 'end';
      }

      let asked = false;
      for (const toolCall of toolCalls) {
        toolRuns += 1;
        emit({ t: 'tool', id: toolCall.id, name: toolCall.name, label: registry.doing(toolCall.name), state: 'started' });
        const result = toolRuns > caps.toolCalls
          ? { ok: false, forModel: { ok: false, error: { code: 'LIMIT', message: 'No more tool calls are allowed in this turn. Answer with what you have.' } }, summary: null, card: null, choices: null, terminal: false }
          : await registry.run({ name: toolCall.name, argsJson: toolCall.args, view, ctx: contextFor(toolCall.id), logger, allowWrites });
        emit({ t: 'tool', id: toolCall.id, state: 'finished', ok: result.ok, summary: result.summary });
        if (result.action) emit({ t: 'action', action: result.action });
        if (result.card) emit({ t: 'card', id: toolCall.id, card: result.card });
        if (result.choices) emit({ t: 'choices', id: toolCall.id, ...result.choices });

        const content = JSON.stringify(result.forModel);
        await store.append(conversation.id, turnId, {
          role: 'tool', toolCallId: toolCall.id, toolName: toolCall.name, content,
          display: { label: registry.doing(toolCall.name), ok: result.ok, summary: result.summary, card: result.card, choices: result.choices },
        });
        messages.push({ role: 'tool', toolCallId: toolCall.id, content });
        if (result.terminal && result.ok) asked = true;
      }
      if (asked) return 'choices';
      if (signal.aborted) return 'aborted';
    }

    emit({ t: 'error', code: 'limit', message: MESSAGES.limit, retryable: false });
    return 'limit';
  } catch (err) {
    if (err instanceof ToolError) {
      emit({ t: 'error', code: 'invalid', message: err.message, retryable: false });
      return 'error';
    }
    logger.error({ err }, 'Assistant: the turn failed');
    emit({ t: 'error', code: 'unavailable', message: MESSAGES.unavailable, retryable: true });
    return 'error';
  } finally {
    // Keep what this turn learned, whatever way it ended.
    await store.touch(conversation.id, refs.toJSON(), conversation.title ? null : text).catch((err) => logger.warn({ err }, 'Assistant: the conversation could not be updated'));
  }
}

module.exports = { runTurn, recent };
