// services/assistant/tools/staff/guide.js
//
// find_feature: where something lives in School Mule and how to get there
// (services/assistant/guide). The answer is the steps to follow by hand, a
// link to the page, and whether Muley can do it for the person.
//
// ask_user_to_choose: put a short question to the person with a few options
// to tap, instead of guessing between two students called Yusuf.

const { defineTool } = require('../registry');
const guide = require('../../guide/find');

const STAFF = ['ADMIN', 'TEACHER'];
const EVERYONE = ['ADMIN', 'TEACHER', 'PARENT'];

defineTool({
  name: 'find_feature',
  doing: 'Checking where that is',
  description:
    'Find where something is in School Mule and how to do it: a page ("report templates", "school stamp") or a task ("leave a student out of the class average", "publish grades"). Returns the steps to follow, whether this person can open it, and shows them a button that opens the page. Use it whenever the person asks where something is or how to do something. Pass the class ref when the question is about one class.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What they are looking for, in a few words.' },
      class: { type: ['string', 'null'], description: 'The class ref the question is about, or null.' },
    },
    required: ['query', 'class'],
    additionalProperties: false,
  },
  views: EVERYONE,
  handler: async (args, ctx) => {
    const cls = args.class ? ctx.refs.resolve(args.class, 'class') : null;
    const hits = guide.find(String(args.query).slice(0, 200), { parent: Boolean(ctx.access && ctx.access.view === 'PARENT') });
    if (hits.length === 0) {
      return { summary: 'Nothing in the guide matched', forModel: { results: [], note: 'Nothing in the site guide matched. Say so plainly; do not guess where it is.' } };
    }
    const results = hits.map(({ entry }) => {
      const allowed = guide.canOpen(entry, ctx.access);
      return {
        title: entry.title,
        steps: entry.steps,
        canOpen: allowed,
        whoCan: allowed ? null : guide.whoCan(entry),
        muleyCanHelpWith: [].concat(entry.muley || []).find((tool) => ctx.offers && ctx.offers(tool)) || null,
        path: allowed ? guide.pathFor(entry, cls ? cls.id : null) : null,
      };
    });
    const best = results[0];
    return {
      summary: `Found "${best.title}"`,
      // The path is for the button, not for the model to read out: it can hold an id.
      forModel: { results: results.map(({ path, ...rest }) => rest), note: 'A button that opens the first result is already shown when the person can open it. Give the steps in your reply.' },
      // A button only for a clear match: when two pages fit as well, the reply names both instead.
      card: best.canOpen && guide.isClear(hits) ? { type: 'link', label: `Open ${best.title}`, href: best.path } : null,
    };
  },
});

defineTool({
  name: 'ask_user_to_choose',
  doing: 'Asking you to choose',
  description:
    'Ask the person to pick between two to six options they can tap. Use it when what they said matches more than one student, class or assessment, or when you need one fact to go on. After calling it, stop: their choice arrives as their next message.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, short.' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'What the option says.' },
            ref: { type: ['string', 'null'], description: 'The ref this option stands for, or null.' },
          },
          required: ['label', 'ref'],
          additionalProperties: false,
        },
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  views: EVERYONE,
  terminal: true,
  handler: async (args, ctx) => {
    const options = args.options.map((option, index) => {
      // An option may only stand for something this conversation has read.
      if (option.ref) ctx.refs.resolve(option.ref);
      return { id: `o${index + 1}`, label: String(option.label).slice(0, 80), ref: option.ref || null };
    });
    return {
      summary: null,
      forModel: { presented: true, note: 'The options are shown. Wait for the person to choose.' },
      choices: { question: String(args.question).slice(0, 200), options },
    };
  },
});
