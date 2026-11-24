'use strict';

/**
 * Tool-result truncation + transcript compaction for SiraCode.
 *
 * Independent rewrite of OpenCode `Truncate.output` and
 * `SessionCompaction` (anomalyco/opencode, MIT, commit
 * 4cf9db957485dd51a5b195fb6e2c1e03d8da1107):
 *   - cap tool output by lines + bytes, keep the recent tail, shrink older tool
 *     messages
 *   - staged exchange-level compaction (`OUTPUTS_CLIPPED → OUTPUTS_REMOVED →
 *     USER_ONLY → OMITTED`) shortening oldest exchanges first while preserving
 *     system prefix and never omitting the newest exchange
 *
 * Not a vendor copy — no Effect runtime, no LLM summarizer, no global
 * tool-output directory, no OpenRouter. Spanish product copy only.
 */

const TOOL_RESULT_MAX_LINES = 400;
const TOOL_RESULT_MAX_BYTES = 24 * 1024;
const STALE_TOOL_MAX_LINES = 8;
const STALE_TOOL_MAX_BYTES = 1024;
const PROTECT_TAIL_TOOLS = 2;
const TRUNCATION_MARKER = '…[resultado truncado]';
const COMPACT_STAGE = 'compacting';
const COMPACT_LABEL = 'Compactando contexto';

const COMPACTION_LEVELS = Object.freeze({
  FULL: 0,
  OUTPUTS_CLIPPED: 1,
  OUTPUTS_REMOVED: 2,
  USER_ONLY: 3,
  OMITTED: 4,
});
const STAGED_CLIP_CHARS = 2_000;

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function stripPriorMarker(text) {
  const raw = String(text == null ? '' : text);
  const idx = raw.indexOf(TRUNCATION_MARKER);
  if (idx === -1) return raw;
  return raw.slice(0, idx).replace(/\s+$/g, '');
}

function truncateToolResult(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const hadMarker = raw.includes(TRUNCATION_MARKER);
  const body = stripPriorMarker(raw);
  const maxLines = Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0
    ? Math.floor(Number(opts.maxLines))
    : TOOL_RESULT_MAX_LINES;
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0
    ? Math.floor(Number(opts.maxBytes))
    : TOOL_RESULT_MAX_BYTES;
  const direction = opts.direction === 'tail' ? 'tail' : 'head';
  const lines = body.split('\n');
  const totalBytes = byteLength(body);

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: hadMarker ? raw : body,
      truncated: hadMarker,
      omittedLines: 0,
      omittedBytes: 0,
    };
  }

  const kept = [];
  let bytes = 0;
  let hitBytes = false;

  if (direction === 'head') {
    for (let i = 0; i < lines.length && kept.length < maxLines; i += 1) {
      const size = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      kept.push(lines[i]);
      bytes += size;
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i -= 1) {
      const size = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      kept.unshift(lines[i]);
      bytes += size;
    }
  }

  const omittedLines = Math.max(0, lines.length - kept.length);
  const omittedBytes = Math.max(0, totalBytes - bytes);
  const unit = hitBytes && omittedBytes >= omittedLines ? 'bytes' : 'líneas';
  const omitted = unit === 'bytes' ? omittedBytes : omittedLines;
  const hint = `(${omitted} ${unit} omitidas — usa read/grep con offset)`;
  const preview = kept.join('\n');
  const content = direction === 'head'
    ? `${preview}\n${TRUNCATION_MARKER}\n${hint}`
    : `${TRUNCATION_MARKER}\n${hint}\n${preview}`;

  return {
    content,
    truncated: true,
    omittedLines,
    omittedBytes,
  };
}

function isToolMessage(message) {
  return Boolean(message && message.role === 'tool');
}

function clipHeadTail(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const half = Math.max(32, Math.floor((maxChars - TRUNCATION_MARKER.length - 2) / 2));
  return `${s.slice(0, half)}\n${TRUNCATION_MARKER}\n${s.slice(-half)}`;
}

function renderExchangeAtLevel(group, level, clipChars) {
  if (level >= COMPACTION_LEVELS.OMITTED) return [];
  if (level === COMPACTION_LEVELS.FULL) return group;
  if (level === COMPACTION_LEVELS.OUTPUTS_CLIPPED) {
    return group.map((msg) => {
      if (!isToolMessage(msg)) return msg;
      const body = String(msg.content ?? '');
      if (body.length <= clipChars) return msg;
      return { ...msg, content: clipHeadTail(body, clipChars) };
    });
  }
  if (level === COMPACTION_LEVELS.OUTPUTS_REMOVED) {
    return group.map((msg) => {
      if (isToolMessage(msg)) {
        return { ...msg, content: '[salida de herramienta omitida por compactación]' };
      }
      const body = String(msg.content ?? '');
      if (body.length <= clipChars) return msg;
      return { ...msg, content: clipHeadTail(body, clipChars) };
    });
  }
  // USER_ONLY: retain only user messages (clipped), dropping assistant/tool noise.
  return group
    .filter((msg) => msg && msg.role === 'user')
    .map((msg) => {
      const body = String(msg.content ?? '');
      if (body.length <= clipChars) return msg;
      return { ...msg, content: clipHeadTail(body, clipChars) };
    });
}

function messagesCharTotal(messages) {
  let total = 0;
  for (const m of messages) total += String(m?.content ?? '').length;
  return total;
}

/**
 * Staged exchange-level compaction adapted from OpenCode
 * `SessionCompaction.flattenAndDropOldest`:
 *   - Keeps leading system messages untouched (cache prefix stability).
 *   - Groups subsequent messages into exchanges starting at each user message.
 *   - Advances exchanges oldest-first through levels 1 → 2 → 3 → 4 until total
 *     chars fit `maxChars`, reaching level k on all older exchanges before any
 *     moves to k + 1.
 *   - Never omits the newest exchange.
 */
function compactTranscriptStaged(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxChars = Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
    ? Math.floor(Number(opts.maxChars))
    : 0;
  const clipChars = Number.isFinite(Number(opts.clipChars)) && Number(opts.clipChars) > 0
    ? Math.floor(Number(opts.clipChars))
    : STAGED_CLIP_CHARS;

  if (!maxChars || messagesCharTotal(list) <= maxChars) {
    return { messages: list, compacted: false, omittedExchanges: 0, maxLevel: 0 };
  }

  let prefixEnd = 0;
  while (prefixEnd < list.length && list[prefixEnd] && list[prefixEnd].role === 'system') {
    prefixEnd += 1;
  }
  const systemPrefix = list.slice(0, prefixEnd);
  const rest = list.slice(prefixEnd);
  if (!rest.length) {
    return { messages: list, compacted: false, omittedExchanges: 0, maxLevel: 0 };
  }

  const exchanges = [];
  for (const msg of rest) {
    if (msg && msg.role === 'user' || exchanges.length === 0) {
      exchanges.push([msg]);
    } else {
      exchanges[exchanges.length - 1].push(msg);
    }
  }

  const levels = exchanges.map(() => COMPACTION_LEVELS.FULL);
  const rendered = exchanges.map((group) => [
    renderExchangeAtLevel(group, COMPACTION_LEVELS.FULL, clipChars),
    renderExchangeAtLevel(group, COMPACTION_LEVELS.OUTPUTS_CLIPPED, clipChars),
    renderExchangeAtLevel(group, COMPACTION_LEVELS.OUTPUTS_REMOVED, clipChars),
    renderExchangeAtLevel(group, COMPACTION_LEVELS.USER_ONLY, clipChars),
    [],
  ]);

  let total = messagesCharTotal(systemPrefix)
    + rendered.reduce((sum, variants) => sum + messagesCharTotal(variants[0]), 0);
  const newest = exchanges.length - 1;
  let maxLevel = 0;

  for (const level of [
    COMPACTION_LEVELS.OUTPUTS_CLIPPED,
    COMPACTION_LEVELS.OUTPUTS_REMOVED,
    COMPACTION_LEVELS.USER_ONLY,
    COMPACTION_LEVELS.OMITTED,
  ]) {
    for (let i = 0; i < exchanges.length && total > maxChars; i += 1) {
      if (i === newest && rendered[i][level].length === 0) continue;
      const beforeChars = messagesCharTotal(rendered[i][levels[i]]);
      const afterChars = messagesCharTotal(rendered[i][level]);
      if (afterChars >= beforeChars && level !== COMPACTION_LEVELS.OMITTED) continue;
      total += afterChars - beforeChars;
      levels[i] = level;
      if (level > maxLevel) maxLevel = level;
    }
  }

  let omittedExchanges = 0;
  const body = [];
  for (let i = 0; i < exchanges.length; i += 1) {
    const chunk = rendered[i][levels[i]];
    if (chunk.length === 0) omittedExchanges += 1;
    else body.push(...chunk);
  }
  if (omittedExchanges > 0) {
    body.unshift({
      role: 'user',
      content: `[${omittedExchanges} intercambio${omittedExchanges === 1 ? '' : 's'} anterior${omittedExchanges === 1 ? '' : 'es'} omitido${omittedExchanges === 1 ? '' : 's'} por límite de contexto]`,
    });
  }

  const finalMessages = [...systemPrefix, ...body];
  const compacted = maxLevel > 0 || omittedExchanges > 0;
  return { messages: finalMessages, compacted, omittedExchanges, maxLevel };
}

function compactTranscript(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const protectTail = Number.isFinite(Number(opts.protectTail))
    ? Math.max(0, Math.floor(Number(opts.protectTail)))
    : PROTECT_TAIL_TOOLS;
  const toolIndexes = [];
  for (let i = 0; i < list.length; i += 1) {
    if (isToolMessage(list[i])) toolIndexes.push(i);
  }
  const staleCutoff = Math.max(0, toolIndexes.length - protectTail);
  const staleSet = new Set(toolIndexes.slice(0, staleCutoff));

  let compacted = false;
  let next = list.map((message, idx) => {
    if (!isToolMessage(message)) return message;
    const limits = staleSet.has(idx)
      ? {
        maxLines: Number.isFinite(Number(opts.staleMaxLines)) ? Number(opts.staleMaxLines) : STALE_TOOL_MAX_LINES,
        maxBytes: Number.isFinite(Number(opts.staleMaxBytes)) ? Number(opts.staleMaxBytes) : STALE_TOOL_MAX_BYTES,
      }
      : {
        maxLines: opts.maxLines,
        maxBytes: opts.maxBytes,
      };
    const out = truncateToolResult(message.content, limits);
    if (out.content === String(message.content || '')) return message;
    compacted = true;
    return { ...message, content: out.content };
  });

  if (Number.isFinite(Number(opts.maxTotalChars)) && Number(opts.maxTotalChars) > 0) {
    const staged = compactTranscriptStaged(next, {
      maxChars: Number(opts.maxTotalChars),
      clipChars: opts.clipChars,
    });
    if (staged.compacted) {
      next = staged.messages;
      compacted = true;
    }
  }

  return { messages: next, compacted };
}

function applyCompactedTranscript(transcript, compacted) {
  if (!Array.isArray(transcript) || !compacted || !Array.isArray(compacted.messages)) {
    return transcript;
  }
  if (!compacted.compacted) return transcript;
  transcript.splice(0, transcript.length, ...compacted.messages);
  return transcript;
}

module.exports = {
  TOOL_RESULT_MAX_LINES,
  TOOL_RESULT_MAX_BYTES,
  STALE_TOOL_MAX_LINES,
  STALE_TOOL_MAX_BYTES,
  PROTECT_TAIL_TOOLS,
  TRUNCATION_MARKER,
  COMPACT_STAGE,
  COMPACT_LABEL,
  COMPACTION_LEVELS,
  STAGED_CLIP_CHARS,
  truncateToolResult,
  compactTranscriptStaged,
  compactTranscript,
  applyCompactedTranscript,
};
