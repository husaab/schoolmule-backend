// services/assistant/tools/staff/assets.js
//
// Replacing the school's logo, stamp or principal signature with an image
// the person attached in Muley's panel. The tool only prepares it: the card
// shows the current image beside the new one, and the school-assets route
// makes the change when the person presses Save (school setup permission,
// the current file kept first so Undo, or School Assets, can bring it back).

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');
const { KINDS } = require('../../actions/kinds');
const attachments = require('../../attachments');

const ASSETS = { school_stamp: 'School stamp', logo: 'School logo', principal_signature: 'Principal signature' };

defineTool({
  name: 'propose_school_asset',
  doing: 'Preparing the new image',
  writes: true,
  description:
    'Prepare replacing the school\'s stamp, logo or principal signature with an image the person attached in this conversation (a file ref such as f1), for them to save. Only use a file they attached; if they asked for a change but attached nothing, ask them to attach the image with the paperclip. The current file is kept and can be brought back.',
  parameters: {
    type: 'object',
    properties: {
      asset: { type: 'string', enum: Object.keys(ASSETS), description: 'Which image to replace.' },
      file: { type: 'string', description: 'The ref of the attached image, such as "f1".' },
    },
    required: ['asset', 'file'],
    additionalProperties: false,
  },
  views: ['ADMIN', 'TEACHER'],
  handler: async (args, ctx) => {
    const file = ctx.refs.resolve(args.file, 'file');
    const who = { school: ctx.user.school, userId: ctx.user.userId };
    const kind = KINDS.school_asset;
    const kindArgs = { schoolCode: who.school, assetType: args.asset };
    // Reading the asset's history needs school setup: someone without it is told so here.
    const current = (await kind.read(ctx.read, kindArgs))[args.asset];
    const next = await attachments.previewUrl(who, file.id);
    if (!next) throw new ToolError('ATTACHMENT_GONE', 'That attached image is no longer there. Ask the person to attach it again.');

    const label = ASSETS[args.asset];
    const action = await ctx.propose({
      kind: 'school_asset',
      title: `${label} from ${file.label}`,
      args: { ...kindArgs, targets: { [args.asset]: { attachmentId: file.id } } },
      before: { [args.asset]: current },
      preview: { rows: [{ key: args.asset, name: label }] },
    });
    return {
      summary: `New ${label.toLowerCase()} ready to save`,
      forModel: {
        prepared: true,
        asset: label,
        file: file.label,
        replacing: current.path ? 'the current image, which is kept' : 'nothing: the school has none yet',
        note: 'The person now sees the current image beside the new one with a Save button. Nothing is saved until they press it. In one or two sentences, say what will change and that they can press Save. Do not say it was saved.',
      },
      action,
      card: {
        type: 'asset_change',
        actionId: action.id,
        title: label,
        subtitle: file.label,
        now: attachments.liveUrl(current.path),
        next,
        note: current.path
          ? 'The current one is kept: School Assets lists it under Earlier versions, and Undo brings it back.'
          : 'The school has no image here yet. It prints on report cards once saved.',
      },
    };
  },
});
