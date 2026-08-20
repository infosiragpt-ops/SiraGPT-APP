'use strict';

/**
 * computer_* tools for /code department agents.
 *
 * Drive the member's one persistent Linux desktop (ensureSession(userId)).
 * Descriptions must never mention a webtop CEO Office. Persistent executor
 * is selected over any injected webtop backend.
 */

const persistent = require('./persistent');
const control = require('./control-loop');

const COMPUTER_SYSTEM_INSTRUCTION = [
  'You can drive the member\'s one persistent Linux desktop at computer.siragpt.com. Every department of this user shares that same always-on machine — there is no per-department desktop.',
  'If a public page needs a real browser, use computer_navigate, then computer_screenshot, then computer_click / computer_type.',
  'Never claim the page opened, loaded, or was interacted with without a matching tool result. Do not invent desktop state.',
  'If the model has no vision, computer_screenshot returns the Chrome CDP accessibility tree (text), not pixels.',
].join(' ');

const COMPUTER_ONLY_TOOL_NAMES = Object.freeze([
  'computer_navigate',
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'web_search',
  'read_url',
]);

function resolveUserId(argsCtx, opts) {
  return (argsCtx && argsCtx.userId) || (opts && opts.userId) || null;
}

function resolveExecutor(opts, userId) {
  return persistent.selectComputerExecutor({
    userId,
    env: opts.env,
    persistent: opts.persistent,
    webtop: opts.webtop,
  });
}

function requirePersistent(selected) {
  if (!selected || selected.kind !== 'persistent') {
    const err = new Error(
      selected && selected.kind === 'webtop'
        ? 'webtop desktop is not used; attach the persistent member session'
        : 'persistent member desktop is not available',
    );
    err.code = selected && selected.kind === 'webtop' ? 'WEBTOP_REJECTED' : 'PERSISTENT_UNAVAILABLE';
    throw err;
  }
  return selected;
}

function formatError(err) {
  return `ERROR: ${err && err.message ? err.message : err}`;
}

function buildComputerTools(opts = {}) {
  const client = opts.client || persistent;

  const executeWithSession = async (userId, fn) => {
    const selected = requirePersistent(resolveExecutor(opts, userId));
    const session = await client.ensureSession(userId, {
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
    return fn(session, selected);
  };

  return [
    {
      name: 'computer_navigate',
      description:
        'Open a public http(s) URL in Chrome on the member\'s persistent Linux desktop (shared by every department of this user). Call computer_screenshot afterwards before describing the page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to open in the desktop browser.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        try {
          const userId = resolveUserId(ctx, opts);
          if (!userId) return 'ERROR: computer_navigate requires the authenticated member id.';
          const selected = requirePersistent(resolveExecutor(opts, userId));
          const result = await client.navigate(userId, { url: args && args.url }, {
            env: opts.env,
            fetchImpl: opts.fetchImpl,
            navigatePage: opts.navigatePage,
          });
          return JSON.stringify({
            ok: true,
            backend: selected.kind,
            memberKey: selected.memberKey,
            url: result.url,
            sessionId: result.session && result.session.sessionId,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'computer_screenshot',
      description:
        'Observe the member\'s persistent Linux desktop. Without vision this returns the Chrome CDP accessibility tree (text). Confirm the tool result before claiming anything is on screen.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_args, ctx) {
        try {
          const userId = resolveUserId(ctx, opts);
          if (!userId) return 'ERROR: computer_screenshot requires the authenticated member id.';
          return await executeWithSession(userId, async (session, selected) => {
            const observeFn = client.observe || client.screenshot;
            const observation = await observeFn(userId, {
              session,
              env: opts.env,
              fetchImpl: opts.fetchImpl,
              model: opts.model || (ctx && ctx.model),
              cdpMode: opts.cdpMode,
              cdpSnapshot: opts.cdpSnapshot,
              cdpConnect: opts.cdpConnect,
              playwrightImpl: opts.playwrightImpl,
            });
            const mode = observation.mode || 'screenshot';
            const bytes = observation.png ? Buffer.from(String(observation.png), 'base64').length : 0;
            return JSON.stringify({
              ok: true,
              backend: selected.kind,
              memberKey: selected.memberKey,
              sessionId: session.sessionId,
              mode,
              url: observation.url || null,
              title: observation.title || '',
              text: mode === 'cdp' ? observation.text : undefined,
              mediaType: mode === 'screenshot' ? (observation.mediaType || 'image/png') : 'text/plain',
              pngBytes: mode === 'screenshot' ? bytes : 0,
              note: mode === 'cdp'
                ? 'CDP accessibility tree from the persistent member desktop. Do not invent pixels.'
                : 'Screenshot captured on the persistent member desktop. Do not describe pixels you were not given.',
            });
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'computer_click',
      description:
        'Click at coordinates (x, y) on the member\'s persistent Linux desktop. Follow with computer_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'X coordinate in pixels.' },
          y: { type: 'integer', description: 'Y coordinate in pixels.' },
          button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button (default left).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        try {
          const userId = resolveUserId(ctx, opts);
          if (!userId) return 'ERROR: computer_click requires the authenticated member id.';
          return await executeWithSession(userId, async (session, selected) => {
            const result = await client.click(userId, args || {}, {
              session,
              env: opts.env,
              fetchImpl: opts.fetchImpl,
            });
            return JSON.stringify({
              ok: true,
              backend: selected.kind,
              memberKey: selected.memberKey,
              sessionId: session.sessionId,
              x: args && args.x,
              y: args && args.y,
              button: (args && args.button) || 'left',
              result,
            });
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'computer_type',
      description:
        'Type text into the focused control on the member\'s persistent Linux desktop.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type (max 2000 characters).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        try {
          if (!String(args && args.text || '').length) return 'ERROR: computer_type requires `text`.';
          const userId = resolveUserId(ctx, opts);
          if (!userId) return 'ERROR: computer_type requires the authenticated member id.';
          return await executeWithSession(userId, async (session, selected) => {
            const result = await client.typeText(userId, { text: String(args.text).slice(0, 2000) }, {
              session,
              env: opts.env,
              fetchImpl: opts.fetchImpl,
            });
            return JSON.stringify({
              ok: true,
              backend: selected.kind,
              memberKey: selected.memberKey,
              sessionId: session.sessionId,
              typed: String(args.text).slice(0, 2000).length,
              result,
            });
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

function isComputerOnlyName(name) {
  return COMPUTER_ONLY_TOOL_NAMES.includes(String(name || ''));
}

function buildComputerOnlyTools(opts = {}, webTools = []) {
  const desktop = buildComputerTools(opts);
  const web = (Array.isArray(webTools) ? webTools : []).filter((tool) => (
    tool && (tool.name === 'web_search' || tool.name === 'read_url')
  ));
  return control.withRepeatGuard([...desktop, ...web], { guard: opts.guard });
}

module.exports = {
  COMPUTER_SYSTEM_INSTRUCTION,
  COMPUTER_ONLY_TOOL_NAMES,
  buildComputerTools,
  buildComputerOnlyTools,
  isComputerOnlyName,
};
