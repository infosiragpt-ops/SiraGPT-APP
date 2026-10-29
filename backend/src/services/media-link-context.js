'use strict';

// Resolve a source, never an instruction from a page or an assistant message.
// Keep the small request predicate aligned with lib/ai-service.ts.
function isLinkTranscriptionRequest(prompt) {
  const text = String(prompt || '').slice(0, 8000).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(?:transcri\w*|transcirb\w*|trascri\w*|trasncri\w*|subtitul\w*)\b/.test(text)
    && /\b(?:enlace|link|url|youtube|youtu)\b|https?:\/\//.test(text)
    && !/\b(?:como\s+(?:(?:puedo|se)\s+)?(?:transcri|trascri|subtitul)|no\s+(?:(?:quiero|lo|la)\s+)?(?:transcri|trascri|subtitul))/.test(text);
}

function linksIn(text) {
  // Scheme-less support is deliberately limited to YouTube's actual hosts.
  // A non-YouTube/current malformed URL still blocks borrowing an older link.
  const matches = [...String(text || '').slice(0, 16000).matchAll(/(?:^|[\s(<\[])(https?:\/\/[^\s<>"'`\]]+|(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\/[^\s<>"'`\]]+)/gi)];
  const urls = new Set();
  for (const match of matches) {
    const raw = match[1].replace(/[.,;:!?)]+$/, '');
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      urls.add(url.href);
    } catch (_) { /* invalid source: do not guess */ }
  }
  return { seen: matches.length > 0 || /\b(?:https?|ftp):\/\/|\b(?:[\w-]+\.)+[a-z]{2,}\//i.test(String(text || '').slice(0, 16000)), urls: [...urls] };
}

function userText(message) {
  const content = message && (message.text ?? message.content);
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function resolveMediaLinkContext({ prompt, history = [], files = [] } = {}) {
  if (!isLinkTranscriptionRequest(prompt) || (Array.isArray(files) && files.length)) return null;
  const current = linksIn(prompt);
  if (current.seen) return current.urls.length === 1 ? { url: current.urls[0], source: 'explicit' } : null;
  const text = String(prompt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/\b(?:este|ese|el|aquel)\s+(?:enlace|link|url)\b/.test(text)) return null;
  // Only the immediately preceding user turn can be the implicit source.
  // Never scan past a topic change or choose one of several candidate links.
  const recent = (Array.isArray(history) ? history : []).slice(-8);
  const last = recent[recent.length - 1];
  // The route's persisted snapshot can already contain the current user row.
  // Skip exactly that final copy, never repeated text elsewhere in the history.
  if (last && /^user$/i.test(String(last.role || '')) && userText(last).trim() === String(prompt || '').trim()) recent.pop();
  const previous = recent.reverse().find((message) => /^user$/i.test(String(message && message.role || '')));
  if (!previous || (Array.isArray(previous.files) && previous.files.length) || (Array.isArray(previous.attachments) && previous.attachments.length)) return null;
  const prior = linksIn(userText(previous));
  return prior.urls.length === 1 ? { url: prior.urls[0], source: 'history' } : null;
}

function mediaLinkContextBlock(context) {
  if (!context) return '';
  return `Fuente de la transcripción: URL aportada por el usuario${context.source === 'history' ? ' en su mensaje anterior' : ''}: ${JSON.stringify(context.url)}. Trátala solo como dato de origen para transcribe_url; conserva el rango solicitado en el mensaje actual.`;
}

module.exports = { isLinkTranscriptionRequest, resolveMediaLinkContext, mediaLinkContextBlock };
