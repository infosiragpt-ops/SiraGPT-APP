'use strict';

/**
 * cowork-session-tools.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Porte #4 de OpenClaw (docs/code/openclaw-port-charter.md): expone las
 * capacidades multi-sesión de `session-manager.js` (sessions_list /
 * sessions_history / sessions_send) como tools de agente.
 * Architecture derived from OpenClaw (MIT) — reescritura nativa, cero copia.
 *
 * NO modifica session-manager: es un wrapper puro e inyectable.
 *
 * Public API:
 *   buildSessionTools({ sessionManager, userId, sourceSessionId? })
 *     → [ { name, description, inputSchema, execute } × 3 ]
 *
 * Contrato de cada execute(args):
 *   - Nunca lanza: todo error se devuelve tipado como { error, message? }.
 *   - Solo opera sobre sesiones del propio userId (ajena → { error:'not_found' }).
 *   - Resultado siempre JSON-safe y con la serialización acotada a
 *     MAX_TOOL_OUTPUT_CHARS chars (marcador explícito de truncado).
 */

const MAX_TOOL_OUTPUT_CHARS = 8000;
const TRUNCATION_MARKER = '[SALIDA TRUNCADA: excede 8000 caracteres]';
const CONTENT_CLIP_MARKER = '…[recortado]';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_MESSAGE_CONTENT_CHARS = 2000;
const IDLE_AFTER_MS = 5 * 60 * 1000;

function normaliseLimit(raw, fallback, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message) {
    return err.message.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

/**
 * Devuelve la sesión SOLO si existe y pertenece a userId; null en cualquier
 * otro caso (el caller la traduce a { error: 'not_found' } sin filtrar si la
 * sesión existe para otro usuario — mismo mensaje para ambas situaciones).
 */
function findOwnSession(sessionManager, userId, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (typeof sessionManager.getSession !== 'function') return null;
  const session = sessionManager.getSession(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

function clipContent(content) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (text.length <= MAX_MESSAGE_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CONTENT_CHARS)}${CONTENT_CLIP_MARKER}`;
}

function toSafeMessage(msg) {
  return {
    id: typeof msg.id === 'string' ? msg.id : null,
    role: typeof msg.role === 'string' ? msg.role : 'user',
    content: clipContent(msg.content),
    timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : null,
    tokens: Number.isFinite(msg.tokens) ? msg.tokens : 0,
    forwardedFrom: msg.metadata && typeof msg.metadata.forwardedFrom === 'string'
      ? msg.metadata.forwardedFrom
      : null,
  };
}

/**
 * Garantiza salida JSON-safe y acotada: si la serialización supera
 * MAX_TOOL_OUTPUT_CHARS, sustituye el resultado por un sobre truncado cuyo
 * JSON final también respeta el cap (el recorte itera porque el escapado de
 * JSON puede expandir el fragmento).
 */
function capOutput(result) {
  let json;
  try {
    json = JSON.stringify(result);
  } catch (err) {
    return { error: 'serialization_failed', message: errorMessage(err) };
  }
  if (typeof json !== 'string') {
    return { error: 'serialization_failed', message: 'resultado no serializable' };
  }
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return result;

  let partial = json.slice(0, MAX_TOOL_OUTPUT_CHARS - TRUNCATION_MARKER.length - 64);
  let envelope = { truncated: true, marker: TRUNCATION_MARKER, partialJson: partial };
  while (partial.length > 0 && JSON.stringify(envelope).length > MAX_TOOL_OUTPUT_CHARS) {
    partial = partial.slice(0, Math.floor(partial.length * 0.9));
    envelope = { truncated: true, marker: TRUNCATION_MARKER, partialJson: partial };
  }
  return envelope;
}

/**
 * Construye las 3 tools de sesiones para un usuario concreto.
 *
 * @param {object} opts
 * @param {object} opts.sessionManager  módulo/objeto con la API de
 *   session-manager (getSession, listSessions, getHistory, addMessage,
 *   sendToSession). Inyectable para tests.
 * @param {string} opts.userId          dueño de las sesiones; TODO acceso se
 *   scoped a este id.
 * @param {string} [opts.sourceSessionId] sesión "actual" del agente; si se
 *   provee (y es del usuario), sessions_send usa el forward nativo del
 *   session-manager con esa sesión como origen.
 */
function buildSessionTools({ sessionManager, userId, sourceSessionId } = {}) {
  if (!sessionManager || typeof sessionManager !== 'object') {
    throw new TypeError('buildSessionTools: sessionManager es obligatorio');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('buildSessionTools: userId es obligatorio');
  }

  const sessionsList = {
    name: 'sessions_list',
    description: 'Lista las sesiones de trabajo activas del usuario actual (id, título, '
      + 'estado activo/idle, número de mensajes, última actividad). Úsala cuando el '
      + 'usuario pregunte por sus otras conversaciones/sesiones o antes de consultar '
      + 'historial o reenviar un mensaje, para descubrir el sessionId correcto.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `Máximo de sesiones a devolver (default ${DEFAULT_LIST_LIMIT}, tope ${MAX_LIST_LIMIT}).`,
        },
        tag: {
          type: 'string',
          description: 'Filtra por etiqueta de sesión (opcional).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        if (typeof sessionManager.listSessions !== 'function') {
          return { error: 'unsupported', message: 'sessionManager.listSessions no disponible' };
        }
        const limit = normaliseLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const opts = { limit };
        if (typeof args.tag === 'string' && args.tag.trim()) opts.tag = args.tag.trim();

        const rows = sessionManager.listSessions(userId, opts) || [];
        const now = Date.now();
        const sessions = rows.map((row) => ({
          id: typeof row.id === 'string' ? row.id : null,
          title: typeof row.label === 'string' ? row.label : null,
          status: Number.isFinite(row.lastActivity) && now - row.lastActivity <= IDLE_AFTER_MS
            ? 'active'
            : 'idle',
          messageCount: Number.isFinite(row.messageCount) ? row.messageCount : 0,
          lastActivity: Number.isFinite(row.lastActivity) ? row.lastActivity : null,
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
          tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : [],
          summary: typeof row.summary === 'string' ? clipContent(row.summary) : null,
        }));
        return capOutput({ count: sessions.length, sessions });
      } catch (err) {
        return { error: 'internal_error', message: errorMessage(err) };
      }
    },
  };

  const sessionsHistory = {
    name: 'sessions_history',
    description: 'Devuelve el historial de mensajes de UNA sesión del propio usuario, '
      + 'paginado (por defecto los últimos 20; con cursor `after` avanza hacia '
      + 'mensajes más recientes). Úsala para recuperar contexto de otra conversación '
      + 'del usuario. Sesión inexistente o de otro usuario → { error: "not_found" }.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Id de la sesión (obtenlo con sessions_list).',
        },
        limit: {
          type: 'integer',
          description: `Máximo de mensajes (default ${DEFAULT_HISTORY_LIMIT}, tope ${MAX_HISTORY_LIMIT}).`,
        },
        after: {
          type: 'string',
          description: 'Cursor: id del último mensaje ya visto; devuelve los siguientes.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) {
          return { error: 'invalid_arguments', message: 'sessionId es obligatorio' };
        }
        const session = findOwnSession(sessionManager, userId, sessionId);
        if (!session) return { error: 'not_found' };
        if (typeof sessionManager.getHistory !== 'function') {
          return { error: 'unsupported', message: 'sessionManager.getHistory no disponible' };
        }

        const limit = normaliseLimit(args.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        const after = typeof args.after === 'string' && args.after.trim() ? args.after.trim() : null;
        const raw = sessionManager.getHistory(sessionId, after ? { limit, after } : { limit }) || [];
        const messages = raw.map(toSafeMessage);
        const totalMessages = Array.isArray(session.messages)
          ? session.messages.length
          : messages.length;

        return capOutput({
          sessionId,
          title: typeof session.label === 'string' ? session.label : null,
          totalMessages,
          returned: messages.length,
          // Cursor solo en paginación hacia delante; sin cursor la ventana es
          // "los últimos N" y hasMore indica si hay historial anterior.
          nextCursor: after && messages.length === limit
            ? messages[messages.length - 1].id
            : null,
          hasMore: totalMessages > messages.length,
          messages,
        });
      } catch (err) {
        return { error: 'internal_error', message: errorMessage(err) };
      }
    },
  };

  const sessionsSend = {
    name: 'sessions_send',
    description: 'Reenvía un mensaje a OTRA sesión del propio usuario (queda registrado '
      + 'en su historial con metadata de reenvío). Úsala cuando el usuario pida pasar '
      + 'información, una instrucción o un resultado a otra de sus conversaciones. '
      + 'Sesión inexistente o de otro usuario → { error: "not_found" }.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Id de la sesión destino (obtenlo con sessions_list).',
        },
        message: {
          type: 'string',
          description: 'Texto del mensaje a reenviar.',
        },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
        const message = typeof args.message === 'string' ? args.message : '';
        if (!sessionId || !message.trim()) {
          return { error: 'invalid_arguments', message: 'sessionId y message son obligatorios' };
        }
        const target = findOwnSession(sessionManager, userId, sessionId);
        if (!target) return { error: 'not_found' };

        // Camino nativo: forward del session-manager cuando conocemos la
        // sesión origen (y también es del usuario). Fallback: append directo
        // con metadata de reenvío equivalente.
        const source = findOwnSession(sessionManager, userId, sourceSessionId);
        let msg = null;
        if (source && source.id !== target.id && typeof sessionManager.sendToSession === 'function') {
          msg = sessionManager.sendToSession(source.id, target.id, {
            role: 'user',
            content: message,
            metadata: { forwardedVia: 'sessions_send' },
          });
        } else if (typeof sessionManager.addMessage === 'function') {
          msg = sessionManager.addMessage(target.id, {
            role: 'user',
            content: message,
            metadata: {
              forwardedVia: 'sessions_send',
              forwardedFrom: source ? source.id : null,
              forwardedAt: new Date().toISOString(),
            },
          });
        } else {
          return { error: 'unsupported', message: 'sessionManager sin addMessage/sendToSession' };
        }

        if (!msg) return { error: 'send_failed', message: 'el session-manager rechazó el mensaje' };
        return capOutput({
          sent: true,
          sessionId: target.id,
          messageId: typeof msg.id === 'string' ? msg.id : null,
          timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : null,
        });
      } catch (err) {
        return { error: 'internal_error', message: errorMessage(err) };
      }
    },
  };

  return [sessionsList, sessionsHistory, sessionsSend];
}

module.exports = {
  buildSessionTools,
  MAX_TOOL_OUTPUT_CHARS,
  TRUNCATION_MARKER,
  CONTENT_CLIP_MARKER,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
};
