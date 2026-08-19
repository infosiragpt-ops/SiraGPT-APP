'use strict';

/**
 * codex/edit-matching — graduated match ladder for edit_file (Aider-inspired,
 * clean-room). Models routinely lose a level of indentation or trailing
 * whitespace when quoting a fragment back; a strict indexOf then fails and
 * the agent burns a cycle re-reading the file. The ladder recovers the safe
 * cases without ever guessing:
 *
 *   1. exact       — byte-for-byte indexOf (current behaviour).
 *   2. line-trimmed — the fragment matches a window of file lines when each
 *      line is compared trimmed (indentation/trailing-ws insensitive). Only
 *      accepted when the window is UNIQUE in the file. The replacement is
 *      re-indented by the delta between the file's first matched line and
 *      the fragment's first line, so the edit lands with the file's real
 *      indentation even though the model quoted it shifted.
 *
 * Anything fuzzier (token-normalised, similarity scoring) risks silent wrong
 * edits — deliberately out of scope.
 */

/**
 * @param {string} content file contents
 * @param {string} find    fragment the model wants to replace
 * @returns {{ strategy: 'exact', occurrences: number }
 *         | { strategy: 'line-trimmed', start: number, end: number, occurrences: number, indentDelta: string }
 *         | { strategy: 'none', occurrences: 0 }}
 */
function findMatch(content, find) {
  const text = String(content ?? '');
  const needle = String(find ?? '');
  if (!needle.length) return { strategy: 'none', occurrences: 0 };

  const exact = text.split(needle).length - 1;
  if (exact > 0) return { strategy: 'exact', occurrences: exact };

  // Line-trimmed window scan.
  const findLines = needle.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline in `find` yields an empty last line — ignore it for
  // the window (it carries no content to anchor on).
  while (findLines.length > 1 && findLines[findLines.length - 1].trim() === '') findLines.pop();
  const trimmedFind = findLines.map((l) => l.trim());
  if (!trimmedFind.some((l) => l.length)) return { strategy: 'none', occurrences: 0 };

  const rawLines = text.split('\n');
  const matches = [];
  outer: for (let i = 0; i + trimmedFind.length <= rawLines.length; i += 1) {
    for (let j = 0; j < trimmedFind.length; j += 1) {
      if (rawLines[i + j].replace(/\r$/, '').trim() !== trimmedFind[j]) continue outer;
    }
    matches.push(i);
  }
  if (matches.length !== 1) {
    return { strategy: matches.length ? 'line-trimmed' : 'none', occurrences: matches.length, ...(matches.length === 0 ? {} : { ambiguous: true }) };
  }

  const startLine = matches[0];
  // Char offsets of the matched window (inclusive of its line endings except
  // the trailing newline, which stays in the file).
  let start = 0;
  for (let i = 0; i < startLine; i += 1) start += rawLines[i].length + 1;
  let end = start;
  for (let j = 0; j < trimmedFind.length; j += 1) {
    end += rawLines[startLine + j].length + (j < trimmedFind.length - 1 ? 1 : 0);
  }

  // Indentation delta: file's first matched line vs fragment's first line.
  const fileIndent = (rawLines[startLine].match(/^[ \t]*/) || [''])[0];
  const findIndent = (findLines[0].match(/^[ \t]*/) || [''])[0];
  const indentDelta = fileIndent.slice(findIndent.length); // '' when equal/deeper quote

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

/**
 * Apply the ladder. Returns { ok, next?, strategy?, occurrences?, reason? }.
 * `replaceAll` is only honoured on exact matches — bulk-replacing fuzzy
 * windows would multiply any mis-anchor.
 */
function applyEdit(content, find, replace, { replaceAll = false } = {}) {
  const text = String(content ?? '');
  const match = findMatch(text, find);

  if (match.strategy === 'exact') {
    if (match.occurrences > 1 && !replaceAll) {
      return { ok: false, reason: 'ambiguous', strategy: 'exact', occurrences: match.occurrences };
    }
    const next = replaceAll ? text.split(find).join(replace) : text.replace(find, replace);
    return { ok: true, next, strategy: 'exact', occurrences: replaceAll ? match.occurrences : 1 };
  }

  if (match.strategy === 'line-trimmed') {
    if (match.occurrences !== 1) {
      return { ok: false, reason: 'ambiguous', strategy: 'line-trimmed', occurrences: match.occurrences };
    }
    const next = text.slice(0, match.start) + reindentReplacement(replace, match.indentDelta) + text.slice(match.end);
    return { ok: true, next, strategy: 'line-trimmed', occurrences: 1 };
  }

  return { ok: false, reason: 'not_found', strategy: 'none', occurrences: 0 };
}

module.exports = { findMatch, reindentReplacement, applyEdit };
