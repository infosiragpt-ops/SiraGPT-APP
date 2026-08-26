'use strict';

/**
 * Computer tools for the chat agent-task / agentic-chat loops.
 *
 * Each chat has a live computer+browser (overlay). When AGENT_COMPUTER is
 * on, these tools MUST be in the model-visible list so the assistant
 * never answers as if it lacked a computer or a browser.
 *
 * DeepSeek V4 only. Passwords are typed by the user on the overlay
 * (login-handoff); the model never asks for them in chat.
 */

const { agentComputerEnabled } = require('./flags');
const f7Flags = require('../agent-runner/multimodal/flags');
const { COMPUTER_TOOL_DEFINITIONS, makeComputerExecutors } = require('../agent-runner/multimodal/computer');
const { HAS_COMPUTER_POLICY_ES, POLICY_ES } = require('./login-handoff');

const COMPUTER_TOOL_NAMES = Object.freeze([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_navigate',
]);

function shouldOfferComputerTools(env = process.env) {
  return agentComputerEnabled(env) === true || f7Flags.computerEnabled(env) === true;
}

function jsonResult(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.text === 'string' && value.__f7Image) {
    return value.text;
  }
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function buildNavigateTool({ userId, conversationId, env }) {
  return {
    name: 'computer_navigate',
    description:
      'Abre una URL http(s) en el navegador REAL de la computadora de ESTE chat. Úsala primero para ofertas, reservas, DMV, seguro o cualquier sitio en vivo. Cada chat TIENE una computadora en vivo.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL absoluta http(s) a abrir.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args = {}, ctx = {}) {
      const url = String(args.url || args.href || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: 'invalid_url', message: 'computer_navigate requiere una URL http(s).' };
      }
      const uid = ctx.userId || userId;
      const chatId = ctx.chatId || conversationId;
      const { refuseAgentType, applyObserveHandoff, loginHandoffToolResult, getTakeover, beginTakeover, detectLoginGate } = require('./login-handoff');
      const paused = refuseAgentType({
        toolName: 'computer_navigate',
        conversationId: chatId,
        user: { id: uid },
        url,
      });
      if (paused.refuse) {
        const gate = detectLoginGate({ url, text: url });
        beginTakeover({
          conversationId: chatId,
          user: { id: uid },
          site: gate.site,
          kind: gate.kind || 'captcha',
          reason: paused.reason,
        });
        return loginHandoffToolResult(gate, getTakeover({ conversationId: chatId, user: { id: uid } }));
      }
      try {
        const persistent = require('./persistent');
        const session = await persistent.ensureSession({
          userId: uid,
          conversationId: chatId,
          env: env || process.env,
        });
        try {
          const out = await persistent.agentPost(session, '/navigate', { url }, env);
          const landedUrl = (out && (out.url || out.finalUrl)) || url;
          const handed = applyObserveHandoff(session, {
            url: landedUrl,
            text: `navigated ${landedUrl}`,
            title: (out && out.title) || '',
          }, { user: { id: uid }, conversationId: chatId, identity: session });
          if (handed && handed.loginHandoff) {
            return loginHandoffToolResult(handed.loginGate, handed.takeover);
          }
          return { ok: true, tool: 'computer_navigate', url: landedUrl, result: out, _preview: `Navegando a ${landedUrl}` };
        } catch (navErr) {
          try {
            const opened = await persistent.dockerExec(
              session,
              `google-chrome --new-window ${JSON.stringify(url)} || chromium --new-window ${JSON.stringify(url)} || xdg-open ${JSON.stringify(url)}`,
              { signal: ctx.signal },
            );
            return { ok: true, tool: 'computer_navigate', url, result: opened, _preview: `Abriendo ${url}` };
          } catch (_) {
            return {
              ok: false,
              error: 'computer_starting',
              message: `La computadora de este chat se está abriendo (${navErr && navErr.message ? String(navErr.message).slice(0, 120) : 'orchestrator'}). Reintenta computer_navigate. Cada chat TIENE una computadora en vivo.`,
              url,
            };
          }
        }
      } catch (err) {
        return {
          ok: false,
          error: 'computer_starting',
          message: 'La computadora de este chat se está abriendo. Reintenta computer_navigate. Cada chat TIENE una computadora en vivo.',
          detail: err && err.message ? String(err.message).slice(0, 160) : undefined,
          url,
        };
      }
    },
  };
}

function openaiDefToReactTool(def, executors, extras) {
  const fn = def && def.function ? def.function : def;
  const name = fn && fn.name;
  return {
    name,
    description: fn.description,
    parameters: fn.parameters || { type: 'object', properties: {} },
    async execute(args = {}, ctx = {}) {
      const run = executors[name];
      if (typeof run !== 'function') {
        return { ok: false, error: 'computer_tool_missing', message: `Herramienta ${name} no disponible.` };
      }
      const merged = {
        ...args,
        conversationId: args.conversationId || ctx.chatId || extras.conversationId,
        userId: args.userId || ctx.userId || extras.userId,
      };
      const out = await run(merged, { signal: ctx.signal });
      ctx.onEvent?.({ type: 'tool_output', tool: name, ok: true, preview: String(jsonResult(out)).slice(0, 160) });
      return jsonResult(out);
    },
  };
}

function buildChatComputerTools({ userId, conversationId, env = process.env, session } = {}) {
  if (!shouldOfferComputerTools(env)) return [];
  const built = makeComputerExecutors({
    env,
    userId,
    session,
    computerEnabled: true,
  });
  const tools = COMPUTER_TOOL_DEFINITIONS.map((def) => openaiDefToReactTool(def, built.executors, { userId, conversationId }));
  tools.push(buildNavigateTool({ userId, conversationId, env }));
  tools._cleanup = built.cleanup;
  return tools;
}

function offeredComputerToolNames(env = process.env) {
  return shouldOfferComputerTools(env) ? [...COMPUTER_TOOL_NAMES] : [];
}

module.exports = {
  HAS_COMPUTER_POLICY_ES,
  POLICY_ES,
  COMPUTER_TOOL_NAMES,
  shouldOfferComputerTools,
  buildChatComputerTools,
  offeredComputerToolNames,
};
