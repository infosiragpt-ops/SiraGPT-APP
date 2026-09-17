'use strict';

/**
 * Session title from the first real user message.
 *
 * Independent rewrite of OpenCode `SessionPrompt.ensureTitle`
 * (anomalyco/opencode, MIT): run once, skip a custom title, cap ~100
 * chars. Not a vendor copy and not an LLM call — OpenCode's title-agent
 * path fails silently when the small model is down. SiraGPT derives the
 * label locally so `/agentes` reconnect always has a usable session name.
 *
 * Trivial greetings (hola / ok / gracias) do not lock the title. The
 * first non-trivial prompt wins. Plane slash commands are stripped.
 */

const DEFAULT_TITLE = 'Nueva sesión';
const TITLE_MAX_CHARS = 100;
const PLANE_CMD_RE = /^\/(construir|planificar|conversar)\b/i;
const DEFAULT_TITLE_RE = /^(nueva sesi[oó]n|new session)\b/i;

function isDefaultTitle(title) {
  const text = String(title || '').trim();
  if (!text) return true;
  return DEFAULT_TITLE_RE.test(text);
}

function titleFromUserMessage(text) {
  let value = String(text || '');
  value = value.replace(/<think>[\s\S]*?<\/think>/gi, '');
  value = value.replace(/<think>[\s\S]*$/gi, '');
  value = value.trim();
  value = value.replace(PLANE_CMD_RE, '').trim();
  value = (value.split(/\r?\n/)[0] || '').replace(/\s+/g, ' ').trim();
  value = value.replace(/^[-*•>]+\s*/, '').trim();
  if (!value) return '';
  if (value.length > TITLE_MAX_CHARS) {
    return `${value.slice(0, TITLE_MAX_CHARS - 3)}...`;
  }
  return value;
}

function ensureSessionTitle(session, text, { trivial = false } = {}) {
  if (!session) return { title: DEFAULT_TITLE, changed: false };
  if (!isDefaultTitle(session.title)) {
    return { title: session.title, changed: false };
  }
  if (trivial) {
    if (!session.title) session.title = DEFAULT_TITLE;
    return { title: session.title || DEFAULT_TITLE, changed: false };
  }
  const next = titleFromUserMessage(text);
  if (!next) {
    if (!session.title) session.title = DEFAULT_TITLE;
    return { title: session.title || DEFAULT_TITLE, changed: false };
  }
  session.title = next;
  session.updatedAt = Date.now();
  return { title: next, changed: true };
}

module.exports = {
  DEFAULT_TITLE,
  TITLE_MAX_CHARS,
  isDefaultTitle,
  titleFromUserMessage,
  ensureSessionTitle,
};
