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
const { createWorkspaceFileApi } = require('./workspace-files');
const { authorizeComposerTool, composerDeniedResult } = require('../composer-permission');

const COMPUTER_TOOL_NAMES = Object.freeze([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_navigate',
  'computer_list_files',
  'computer_read_file',
  'computer_write_file',
  'computer_edit_file',
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
      const { refuseAgentType, loginHandoffToolResult, getTakeover, beginTakeover, detectLoginGate } = require('./login-handoff');
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
          // Skip agentPost('/navigate') until the computer agent implements it
          // (orch http-proxy hangs ~120s). Open Chrome in the running session.
          const opened = await persistent.dockerExec(
            session,
            `(google-chrome --no-sandbox --disable-dev-shm-usage --user-data-dir=/workspace/.chrome --no-first-run --disable-gpu --new-window ${JSON.stringify(url)} || chromium --no-sandbox --disable-dev-shm-usage --new-window ${JSON.stringify(url)} || xdg-open ${JSON.stringify(url)}) >/tmp/sira-nav.log 2>&1 & echo Opening`,
            { signal: ctx.signal, timeoutMs: 8000 },
          );
          return { ok: true, tool: 'computer_navigate', url, result: opened, _preview: `Abriendo ${url}` };
        } catch (err) {
          return {
            ok: true,
            tool: 'computer_navigate',
            url,
            fallback: 'chrome',
            detail: err && err.message ? String(err.message).slice(0, 160) : undefined,
            _preview: `Abriendo ${url}`,
          };
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

function composerGate(toolName, ctx = {}) {
  const permission = ctx.permission || ctx.toolPermission || (ctx.toolAuthCtx && ctx.toolAuthCtx.permission);
  const auth = authorizeComposerTool(permission, toolName, ctx);
  if (auth.denied || auth.needsPermission) return composerDeniedResult(auth);
  return null;
}

function failToResult(err) {
  return {
    ok: false,
    error: (err && err.code) || 'computer_file_failed',
    message: err && err.message ? String(err.message).slice(0, 240) : 'No se pudo editar el archivo en la computadora.',
  };
}

function buildWorkspaceFileTools({ userId, conversationId, env, persistent } = {}) {
  const files = createWorkspaceFileApi({ persistent });
  const ctxOf = (args, ctx) => ({
    userId: (ctx && ctx.userId) || userId,
    conversationId: (ctx && ctx.chatId) || conversationId,
    env: env || process.env,
    signal: ctx && ctx.signal,
    path: args.path || args.file_path || args.rel,
    content: args.content || args.text || '',
    old_string: args.old_string || args.oldString,
    new_string: args.new_string || args.newString,
  });
  return [
    {
      name: 'computer_list_files',
      description:
        'Lista archivos y carpetas en /workspace de la computadora EN VIVO de ESTE chat. Úsala antes de editar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a /workspace. Vacío = raíz.' },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx = {}) {
        try {
          return await files.listFiles(ctxOf(args, ctx));
        } catch (err) {
          return failToResult(err);
        }
      },
    },
    {
      name: 'computer_read_file',
      description:
        'Lee un archivo de /workspace en la computadora EN VIVO de ESTE chat.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a /workspace, p.ej. notas/todo.txt' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(args = {}, ctx = {}) {
        try {
          return await files.readFile(ctxOf(args, ctx));
        } catch (err) {
          return failToResult(err);
        }
      },
    },
    {
      name: 'computer_write_file',
      description:
        'Crea o sobrescribe un archivo en /workspace de la computadora EN VIVO de ESTE chat y lo abre en pantalla.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a /workspace' },
          content: { type: 'string', description: 'Contenido UTF-8 del archivo' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async execute(args = {}, ctx = {}) {
        const blocked = composerGate('computer_write_file', ctx);
        if (blocked) return blocked;
        try {
          const out = await files.writeFile(ctxOf(args, ctx));
          ctx.onEvent?.({ type: 'tool_output', tool: 'computer_write_file', ok: true, preview: `Escrito ${out.path}` });
          return out;
        } catch (err) {
          return failToResult(err);
        }
      },
    },
    {
      name: 'computer_edit_file',
      description:
        'Reemplaza un fragmento exacto en un archivo de /workspace de la computadora EN VIVO de ESTE chat.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      async execute(args = {}, ctx = {}) {
        const blocked = composerGate('computer_edit_file', ctx);
        if (blocked) return blocked;
        try {
          const out = await files.editFile(ctxOf(args, ctx));
          ctx.onEvent?.({ type: 'tool_output', tool: 'computer_edit_file', ok: true, preview: `Editado ${out.path}` });
          return out;
        } catch (err) {
          return failToResult(err);
        }
      },
    },
  ];
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
  tools.push(...buildWorkspaceFileTools({ userId, conversationId, env }));
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
