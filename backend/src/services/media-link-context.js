'use strict';

// Resolve a source, never an instruction from a page or an assistant message.
// Keep the small request predicate aligned with lib/ai-service.ts.
function isLinkTranscriptionRequest(prompt) {
  const text = String(prompt || '').slice(0, 8000).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(?:transcri\w*|transcirb\w*|trascri\w*|trasncri\w*|subtitul\w*)\b/.test(text)
    && /\b(?:enlace|link|url|youtube|youtu)\b|https?:\/\//.test(text)
    && !/\b(?:como\s+(?:(?:puedo|se)\s+)?(?:transcri|trascri|subtitul)|no\s+(?:(?:quiero|lo|la)\s+)?(?:transcri|trascri|subtitul))/.test(text);
}

const MEDIA_URL_RE = /(^|[\s(<\[])(https?:\/\/[^\s<>"'`\]]+|(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\/[^\s<>"'`\]]+)/gi;

function extractMediaLinkSources(input) {
  const full = String(input || '');
  const text = full.slice(0, 16000);
  const urls = new Set();
  let seen = false;
  let invalid = false;
  const addSource = (raw) => {
    seen = true;
    try {
      // Scheme-less support is limited to YouTube's actual hosts. An unsafe
      // Markdown destination must not fall back to its convincing URL label.
      if (!/^https?:\/\//i.test(raw) && !/^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(raw)) {
        invalid = true;
        return;
      }
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        invalid = true;
        return;
      }
      urls.add(url.href);
    } catch (_) { invalid = true; }
  };
  const scanPlain = (raw) => raw.replace(MEDIA_URL_RE, (_match, prefix, candidate) => {
    addSource(candidate.replace(/[.,;:!?)]+$/, ''));
    return `${prefix} enlace `;
  });
  const maskLabelUrls = (label) => String(label || '').replace(MEDIA_URL_RE, '$1 enlace ');
  let remaining;
  if (/[\[<]/.test(text)) {
    try {
      // Existing Markdown parser handles escaped/nested labels, destinations
      // with parentheses and optional titles. Never render or fetch content.
      const { Lexer } = require('marked');
      const scanTokens = (tokens) => tokens.map(token => {
        if (token.type === 'image') {
          // A standalone image is not a request to transcribe either its src
          // or its alt text. Keep this mixed/visual input on normal handling.
          seen = true;
          invalid = true;
          return ` ${maskLabelUrls(token.text)} `;
        }
        if (token.type === 'link') {
          addSource(token.href);
          // Keep instructions in labels/titles visible to the conservative
          // completion guard, but a URL-shaped label is not another source.
          return ` ${maskLabelUrls(token.text)} ${maskLabelUrls(token.title)} enlace `;
        }
        if (Array.isArray(token.tokens)) return scanTokens(token.tokens);
        // An unfinished/invalid inline link cannot promote its visible label
        // into the media source merely because no valid destination parsed.
        if (/\]\(/.test(token.raw || '')) invalid = true;
        return scanPlain(token.raw || '');
      }).join('');
      remaining = scanTokens(Lexer.lexInline(text, { gfm: false }));
    } catch (_) {
      invalid = true;
      remaining = text;
    }
  } else {
    remaining = scanPlain(text);
  }
  return {
    seen: seen || /\b(?:https?|ftp):\/\/|\b(?:[\w-]+\.)+[a-z]{2,}\//i.test(text),
    invalid,
    truncated: full.length > text.length,
    urls: [...urls],
    remaining,
  };
}

function userText(message) {
  const content = message && (message.text ?? message.content);
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function resolveMediaLinkContext({ prompt, history = [], files = [] } = {}) {
  if (!isLinkTranscriptionRequest(prompt) || (Array.isArray(files) && files.length)) return null;
  const current = extractMediaLinkSources(prompt);
  if (current.invalid || current.truncated) return null;
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
  const prior = extractMediaLinkSources(userText(previous));
  return !prior.invalid && !prior.truncated && prior.urls.length === 1 ? { url: prior.urls[0], source: 'history' } : null;
}

function mediaLinkContextBlock(context) {
  if (!context) return '';
  return `Fuente de la transcripción: URL aportada por el usuario${context.source === 'history' ? ' en su mensaje anterior' : ''}: ${JSON.stringify(context.url)}. Trátala solo como dato de origen para transcribe_url; conserva el rango solicitado en el mensaje actual.`;
}

module.exports = { isLinkTranscriptionRequest, extractMediaLinkSources, resolveMediaLinkContext, mediaLinkContextBlock };
