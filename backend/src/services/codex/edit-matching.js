'use strict';

/**
 * codex/edit-matching — graduated match ladder for edit_file & SiraCode edit.
 *
 * Combines SiraGPT's indentation-drifted line-trimmed recovery with native
 * adaptations from anomalyco/opencode (MIT, commit
 * 4cf9db957485dd51a5b195fb6e2c1e03d8da1107, packages/core/src/tool/plugin/edit.ts):
 *
 *   1. exact              — byte-for-byte match (literal $, no regex replace).
 *   2. crlf-normalized    — exact match on LF view mapped back to CRLF/mixed
 *                           source offsets with LCS per-line ending preservation.
 *   3. unicode-normalized — 1-to-1 typographic quote/dash/NBSP normalization.
 *   4. trailing-ws        — per-line trimEnd + typographic normalization.
 *   5. line-trimmed       — unique indentation-shifted line window; replacement
 *                           is re-indented by delta and preserves region endings.
 *
 * Ambiguous matches are always rejected (unless replaceAll on exact/non-indent
 * tiers). On not_found, emits an actionable Spanish missHint (already-applied
 * detection or closest numbered file lines) so the agent recovers in 1 step.
 */

const {
  normalizeForMatch,
  detectDominantEnding,
  countBefore,
  withRegionEndings,
  buildEditMissHint,
} = require('./opencode-coding-intel');

const CRLF = '\r\n';

function findNonOverlapping(content, search) {
  const matches = [];
  if (!search.length) return matches;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    matches.push({ start: offset, end: offset + search.length });
    offset += search.length;
  }
  return matches;
}

/**
 * Checks whether a single exact/normalized match has an overlapping second
 * occurrence (e.g. searching "aa" in "aaa").
 */
function hasOverlappingSecond(content, search, firstStart) {
  if (firstStart < 0 || !search.length) return false;
  return content.indexOf(search, firstStart + 1) !== -1;
}

/**
 * OpenCode edit.ts:findLineOccurrences — matches whole-line spans ignoring
 * trailing whitespace and typographic variants while keeping leading indent.
 */
function findLineOccurrences(view, search) {
  if (!search.length) return [];
  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  if (!expected.length) return [];

  const lines = [];
  const rx = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = rx.exec(view)) !== null) {
    if (m[0] === '') {
      if (rx.lastIndex === view.length) break;
      rx.lastIndex += 1;
      continue;
    }
    const newline = m[0].endsWith('\n');
    const text = newline ? m[0].slice(0, -1) : m[0];
    lines.push({
      start: m.index,
      end: m.index + m[0].length,
      text,
      contentEnd: m.index + text.length - (text.endsWith('\r') ? 1 : 0),
      newline,
    });
  }

  const normalizedExpected = expected.map((line) => normalizeForMatch(line.trimEnd()));
  const candidates = [];
  for (let i = 0; i + normalizedExpected.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < normalizedExpected.length; j += 1) {
      if (normalizeForMatch(lines[i + j].text.trimEnd()) !== normalizedExpected[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const last = lines[i + normalizedExpected.length - 1];
    if (trailingNewline && !last.newline) continue;
    candidates.push({
      start: lines[i].start,
      end: trailingNewline ? last.end : last.contentEnd,
    });
  }

  // Deduplicate overlapping spans.
  const result = [];
  for (const candidate of candidates) {
    if (result.some((existing) => existing.end > candidate.start && existing.start < candidate.end)) continue;
    result.push(candidate);
  }
  return result;
}

function buildLfMapping(source) {
  const view = source.replaceAll(CRLF, '\n');
  const removed = [];
  const rx = /\r\n/g;
  let m;
  let idx = 0;
  while ((m = rx.exec(source)) !== null) {
    removed.push(m.index - idx);
    idx += 1;
  }
  return { view, removed };
}

function mapViewMatchesToSource(matches, removed) {
  return matches.map((match) => ({
    start: match.start + countBefore(removed, match.start),
    end: match.end + countBefore(removed, match.end),
  }));
}

/**
 * @param {string} content file contents
 * @param {string} find    fragment the model wants to replace
 * @returns {{ strategy: string, occurrences: number, start?: number, end?: number, matches?: Array<{start:number,end:number}>, indentDelta?: string, ambiguous?: boolean }}
 */
function findMatch(content, find) {
  const text = String(content ?? '');
  const needle = String(find ?? '');
  if (!needle.length) return { strategy: 'none', occurrences: 0 };

  // Tier 1: exact byte match.
  const exactMatches = findNonOverlapping(text, needle);
  if (exactMatches.length > 0) {
    const overlapping = exactMatches.length === 1 && hasOverlappingSecond(text, needle, exactMatches[0].start);
    const occurrences = overlapping ? 2 : exactMatches.length;
    return { strategy: 'exact', occurrences, matches: exactMatches, ...(occurrences > 1 ? { ambiguous: true } : {}) };
  }

  // Build LF view once for tiers 2–4 (mirrors OpenCode matchView).
  const { view, removed } = buildLfMapping(text);
  const lfNeedle = needle.replaceAll(CRLF, '\n');

  // Tier 2: exact on LF view (bridges LF find against CRLF/mixed source).
  if (lfNeedle !== needle || removed.length > 0) {
    const lfMatches = findNonOverlapping(view, lfNeedle);
    if (lfMatches.length > 0) {
      const overlapping = lfMatches.length === 1 && hasOverlappingSecond(view, lfNeedle, lfMatches[0].start);
      const occurrences = overlapping ? 2 : lfMatches.length;
      return {
        strategy: 'crlf-normalized',
        occurrences,
        matches: mapViewMatchesToSource(lfMatches, removed),
        ...(occurrences > 1 ? { ambiguous: true } : {}),
      };
    }
  }

  // Tier 3: 1-to-1 typographic normalization (curly quotes, dashes, NBSP).
  const normView = normalizeForMatch(view);
  const normNeedle = normalizeForMatch(lfNeedle);
  const unicodeMatches = findNonOverlapping(normView, normNeedle);
  if (unicodeMatches.length > 0) {
    const overlapping = unicodeMatches.length === 1 && hasOverlappingSecond(normView, normNeedle, unicodeMatches[0].start);
    const occurrences = overlapping ? 2 : unicodeMatches.length;
    return {
      strategy: 'unicode-normalized',
      occurrences,
      matches: mapViewMatchesToSource(unicodeMatches, removed),
      ...(occurrences > 1 ? { ambiguous: true } : {}),
    };
  }

  // Tier 4: trailing-whitespace + typographic normalization per line.
  const trailingMatches = findLineOccurrences(view, lfNeedle);
  if (trailingMatches.length > 0) {
    const occurrences = trailingMatches.length;
    return {
      strategy: 'trailing-ws',
      occurrences,
      matches: mapViewMatchesToSource(trailingMatches, removed),
      ...(occurrences > 1 ? { ambiguous: true } : {}),
    };
  }

  // Tier 5: indentation-drifted line-trimmed window scan (unique only).
  const findLines = lfNeedle.split('\n');
  while (findLines.length > 1 && findLines[findLines.length - 1].trim() === '') findLines.pop();
  const trimmedFind = findLines.map((l) => normalizeForMatch(l.trim()));
  if (!trimmedFind.some((l) => l.length)) return { strategy: 'none', occurrences: 0 };

  const rawLines = text.split('\n');
  const lineMatches = [];
  outer: for (let i = 0; i + trimmedFind.length <= rawLines.length; i += 1) {
    for (let j = 0; j < trimmedFind.length; j += 1) {
      if (normalizeForMatch(rawLines[i + j].replace(/\r$/, '').trim()) !== trimmedFind[j]) continue outer;
    }
    lineMatches.push(i);
  }
  if (lineMatches.length !== 1) {
    return {
      strategy: lineMatches.length ? 'line-trimmed' : 'none',
      occurrences: lineMatches.length,
      ...(lineMatches.length === 0 ? {} : { ambiguous: true }),
    };
  }

  const startLine = lineMatches[0];
  let start = 0;
  for (let i = 0; i < startLine; i += 1) start += rawLines[i].length + 1;
  let end = start;
  for (let j = 0; j < trimmedFind.length; j += 1) {
    const lineLen = rawLines[startLine + j].length;
    // Exclude trailing \r on the final matched line so its line ending stays intact.
    if (j === trimmedFind.length - 1 && rawLines[startLine + j].endsWith('\r')) {
      end += lineLen - 1;
    } else {
      end += lineLen + (j < trimmedFind.length - 1 ? 1 : 0);
    }
  }

  const fileIndent = (rawLines[startLine].match(/^[ \t]*/) || [''])[0];
  const findIndent = (findLines[0].match(/^[ \t]*/) || [''])[0];
  const indentDelta = fileIndent.slice(findIndent.length);

  return { strategy: 'line-trimmed', start, end, occurrences: 1, indentDelta };
}

/**
 * Re-indent every line of `replacement` by `indentDelta` (the amount of
 * indentation the model dropped when quoting `find`). Blank lines stay blank.
 */
function reindentReplacement(replacement, indentDelta) {
  if (!indentDelta) return String(replacement ?? '');
  return String(replacement ?? '')
    .split('\n')
    .map((line) => (line.trim().length ? indentDelta + line : line))
    .join('\n');
}

function applySpanReplacements(text, matches, replacer) {
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const span = matches[i];
    out = out.slice(0, span.start) + replacer(span) + out.slice(span.end);
  }
  return out;
}

/**
 * Apply the graduated ladder. Returns:
 *   { ok: true, next, strategy, occurrences }
 *   or { ok: false, reason: 'ambiguous' | 'not_found', strategy, occurrences, hint? }.
 *
 * `replaceAll` is honoured on exact / crlf-normalized / unicode-normalized /
 * trailing-ws matches, never on indentation-shifted line-trimmed windows.
 * Literal `$` sequences in `replace` are always preserved verbatim.
 */
function applyEdit(content, find, replace, { replaceAll = false } = {}) {
  const text = String(content ?? '');
  const needle = String(find ?? '');
  const replacement = String(replace ?? '');

  // Explicit line-ending-only edits (\r changes) apply strictly to exact bytes.
  const endingsOnly = needle !== replacement && needle.replaceAll('\r', '') === replacement.replaceAll('\r', '');
  if (endingsOnly) {
    const exactMatches = findNonOverlapping(text, needle);
    if (exactMatches.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
        strategy: 'none',
        occurrences: 0,
        hint: buildEditMissHint(text, needle, replacement),
      };
    }
    const overlapping = exactMatches.length === 1 && hasOverlappingSecond(text, needle, exactMatches[0].start);
    const occurrences = overlapping ? 2 : exactMatches.length;
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, reason: 'ambiguous', strategy: 'exact', occurrences };
    }
    const targets = replaceAll ? exactMatches : exactMatches.slice(0, 1);
    const next = applySpanReplacements(text, targets, () => replacement);
    return { ok: true, next, strategy: 'exact', occurrences: targets.length };
  }

  const match = findMatch(text, needle);
  const fileEnding = detectDominantEnding(text, '\n');

  if (match.strategy === 'exact') {
    if (match.occurrences > 1 && !replaceAll) {
      return { ok: false, reason: 'ambiguous', strategy: 'exact', occurrences: match.occurrences };
    }
    const targets = replaceAll ? match.matches : match.matches.slice(0, 1);
    const next = applySpanReplacements(text, targets, () => replacement);
    return { ok: true, next, strategy: 'exact', occurrences: targets.length };
  }

  if (
    match.strategy === 'crlf-normalized'
    || match.strategy === 'unicode-normalized'
    || match.strategy === 'trailing-ws'
  ) {
    if (match.occurrences > 1 && !replaceAll) {
      return { ok: false, reason: 'ambiguous', strategy: match.strategy, occurrences: match.occurrences };
    }
    const targets = replaceAll ? match.matches : match.matches.slice(0, 1);
    const lfReplacement = replacement.replaceAll(CRLF, '\n');
    const next = applySpanReplacements(text, targets, (span) => {
      const region = text.slice(span.start, span.end);
      return withRegionEndings(region, lfReplacement, detectDominantEnding(region, fileEnding));
    });
    return { ok: true, next, strategy: match.strategy, occurrences: targets.length };
  }

  if (match.strategy === 'line-trimmed') {
    if (match.occurrences !== 1) {
      return { ok: false, reason: 'ambiguous', strategy: 'line-trimmed', occurrences: match.occurrences };
    }
    const region = text.slice(match.start, match.end);
    const reindented = reindentReplacement(replacement.replaceAll(CRLF, '\n'), match.indentDelta);
    const aligned = withRegionEndings(region, reindented, detectDominantEnding(region, fileEnding));
    const next = text.slice(0, match.start) + aligned + text.slice(match.end);
    return { ok: true, next, strategy: 'line-trimmed', occurrences: 1 };
  }

  return {
    ok: false,
    reason: 'not_found',
    strategy: 'none',
    occurrences: 0,
    hint: buildEditMissHint(text, needle, replacement),
  };
}

module.exports = {
  findMatch,
  findLineOccurrences,
  reindentReplacement,
  applyEdit,
  buildEditMissHint,
};
