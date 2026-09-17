'use strict';

/**
 * Tool-result truncation + transcript compaction for SiraCode.
 *
 * Independent rewrite of OpenCode `Truncate.output` and
 * `SessionCompaction.prune` (anomalyco/opencode, MIT): cap tool output
 * by lines + bytes, keep the recent tail, shrink older tool messages.
 * Not a vendor copy — no Effect runtime, no LLM summarizer, no global
 * tool-output directory, no OpenRouter.
 *
 * Spanish product copy only.
 */

const TOOL_RESULT_MAX_LINES = 400;
const TOOL_RESULT_MAX_BYTES = 24 * 1024;
const STALE_TOOL_MAX_LINES = 8;
const STALE_TOOL_MAX_BYTES = 1024;
const PROTECT_TAIL_TOOLS = 2;
const TRUNCATION_MARKER = '…[resultado truncado]';
const COMPACT_STAGE = 'compacting';
const COMPACT_LABEL = 'Compactando contexto';

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
  const next = list.map((message, idx) => {
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
  truncateToolResult,
  compactTranscript,
  applyCompactedTranscript,
};
