// services/assistant/tools/registry.js
//
// Muley's tools: what each is called, what it takes, who may use it, and the
// one way a tool call from the model is run.
//
//   defineTool({ name, description, parameters, views, handler, terminal? })
//
//   parameters  JSON Schema the model is held to (strict), and the arguments
//               are checked against again here. A tool never takes a school,
//               a user or a role (those come from the session), and never a
//               database id: things are named by the refs earlier reads gave.
//   doing       what the person sees while it runs ("Reading the gradebook")
//   views       the views that get the tool ('ADMIN', 'TEACHER'; parents get
//               their own set later). Listing only: what a person may read is
//               decided by the routes the tool calls, with their own token.
//   handler     async (args, ctx) => { forModel, summary?, card?, choices? }
//               ctx = { read, refs, access, user, today, pageContext }
//               `read` is the only way to data, and it can only GET.
//   terminal    the turn ends after this tool (it asked the person something).

const { ToolError } = require('../errors');
const { problems } = require('./validate');
const { scrubResult } = require('./shape/scrub');
const config = require('../config');

const TOOLS = new Map();
const FORBIDDEN_PARAMS = /^(school|schoolid|schoolcode|user|userid|role|view|token)$/i;

function assertNoIdentityParams(schema, toolName) {
  for (const [key, inner] of Object.entries(schema.properties || {})) {
    if (FORBIDDEN_PARAMS.test(key)) throw new Error(`Tool ${toolName} may not take "${key}": it comes from the session`);
    if (inner && inner.type === 'object') assertNoIdentityParams(inner, toolName);
    if (inner && inner.items && inner.items.type === 'object') assertNoIdentityParams(inner.items, toolName);
  }
}

function defineTool(tool) {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(tool.name)) throw new Error(`Bad tool name "${tool.name}"`);
  if (TOOLS.has(tool.name)) throw new Error(`Tool "${tool.name}" is defined twice`);
  if (tool.parameters.type !== 'object' || tool.parameters.additionalProperties !== false) {
    throw new Error(`Tool ${tool.name} must take a closed object`);
  }
  assertNoIdentityParams(tool.parameters, tool.name);
  TOOLS.set(tool.name, Object.freeze({ terminal: false, ...tool }));
  return tool;
}

/** The tools a view gets, in name order (a stable order keeps the provider's prompt cache warm). */
const toolsFor = (view) => [...TOOLS.values()].filter((tool) => tool.views.includes(view)).sort((a, b) => a.name.localeCompare(b.name));

/** The definitions as the provider adapter takes them. */
const definitionsFor = (view) => toolsFor(view).map(({ name, description, parameters }) => ({ name, description, parameters }));

const asToolError = (err) =>
  (err instanceof ToolError ? err : new ToolError('TOOL_FAILED', 'That tool hit a problem and could not finish.'));

/**
 * Run one tool call from the model.
 * -> { ok, forModel (already scrubbed and size-capped), summary, card, choices, terminal }
 * Never throws: a failure is an answer the model can read ({ ok: false, error }).
 */
async function run({ name, argsJson, view, ctx, logger }) {
  const tool = TOOLS.get(name);
  const failed = (error) => ({ ok: false, forModel: { ok: false, error: { code: error.code, message: error.message } }, summary: null, card: null, choices: null, terminal: false });

  if (!tool || !tool.views.includes(view)) {
    return failed(new ToolError('UNKNOWN_TOOL', `There is no tool called "${String(name).slice(0, 40)}".`));
  }
  let args;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return failed(new ToolError('INVALID_ARGUMENTS', 'The arguments were not valid JSON.'));
  }
  const found = problems(tool.parameters, args);
  if (found.length > 0) {
    return failed(new ToolError('INVALID_ARGUMENTS', `Fix the arguments: ${found.slice(0, 4).join('; ')}.`));
  }

  try {
    const result = await tool.handler(args, ctx);
    let forModel = scrubResult({ ok: true, ...result.forModel });
    const limit = config.caps().toolResultChars;
    if (JSON.stringify(forModel).length > limit) {
      forModel = { ok: true, truncated: true, note: 'The result was too large to return in full. Ask for something narrower.', summary: result.summary || null };
    }
    return {
      ok: true,
      forModel,
      summary: result.summary || null,
      card: result.card ? scrubResult(result.card) : null,
      choices: result.choices ? scrubResult(result.choices) : null,
      terminal: Boolean(tool.terminal),
    };
  } catch (err) {
    if (!(err instanceof ToolError) && logger) logger.error({ err, tool: name }, 'Assistant tool failed');
    return failed(asToolError(err));
  }
}

/** What the person is shown while a tool runs. */
const doing = (name) => (TOOLS.get(name) && TOOLS.get(name).doing) || 'Working';

module.exports = { defineTool, toolsFor, definitionsFor, run, doing, _tools: TOOLS };
