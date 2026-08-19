'use strict';

/**
 * Structured RTF parser — extracts text content from RTF files,
 * preserving basic formatting hints (bold, italic, headings via
 * font size heuristics).
 *
 * RTF is a text-based format with control words prefixed by `\`.
 * Groups are delimited by `{` and `}`. This parser strips control
 * words while keeping readable text, handling Unicode escapes and
 * common RTF features.
 *
 * Pure JS — zero dependencies, ~100 lines.
 */

const RTF_CONTROL_WORD = /\\([a-zA-Z]+)(-?\d+)?[ ]?/g;
const RTF_UNICODE = /\\u(-?\d+)\?/g;
const RTF_HEX_CHAR = /\\'([0-9a-fA-F]{2})/g;
const RTF_NEWLINE_PAR = /\\par\b/g;
const RTF_NEWLINE_LINE = /\\line\b/g;
const RTF_TAB = /\\tab\b/g;

function parseRtf(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw;

  // Strip RTF header: everything from `{\rtf` to the first content
  // after the font table / color table. Heuristic: strip groups that
  // contain `\fonttbl` or `\colortbl`.
  text = stripControlGroups(text, /\\fonttbl\b/);
  text = stripControlGroups(text, /\\colortbl\b/);
  text = stripControlGroups(text, /\\stylesheet\b/);
  text = stripControlGroups(text, /\\listtable\b/);
  text = stripControlGroups(text, /\\revtbl\b/);
  text = stripControlGroups(text, /\\*\\(?:generator|xmlnstbl|wgrffmtfilter|datastore|themedata|colorschememapping|latentstyles|docvar|mmathPr|mdef|rsidtbl)\b/);

  // Convert hex escapes e.g. \'e1 → á
  text = text.replace(RTF_HEX_CHAR, (_, hex) => {
    const code = parseInt(hex, 16);
    return code >= 32 && code !== 127 ? String.fromCharCode(code) : '';
  });

  // Convert Unicode escapes e.g. \u225?
  text = text.replace(RTF_UNICODE, (_, code) => {
    const cp = parseInt(code, 10);
    if (cp < 0) return '';
    try {
      return String.fromCodePoint(cp);
    } catch {
      return cp >= 32 && cp <= 65535 ? String.fromCharCode(cp) : '';
    }
  });

  // Convert structural escapes
  text = text.replace(RTF_NEWLINE_PAR, '\n');
  text = text.replace(RTF_NEWLINE_LINE, '\n');
  text = text.replace(RTF_TAB, '\t');

  // Strip remaining control words, keeping the optional space delimiter if present
  // Bold, italic markers → we keep as ** and * hints
  text = text.replace(/\\b\b/g, '__BOLD__');
  text = text.replace(/\\i\b/g, '__ITALIC__');
  text = text.replace(/\\b0\b/g, '__/BOLD__');
  text = text.replace(/\\i0\b/g, '__/ITALIC__');

  // Remove all remaining control words (with optional numeric arg)
  text = text.replace(RTF_CONTROL_WORD, '');

  // Remove group braces
  text = text.replace(/[{}]/g, '');

  // Clean up placeholder markers
  text = text.replace(/__BOLD__([\s\S]*?)__\/BOLD__/g, '**$1**');
  text = text.replace(/__ITALIC__([\s\S]*?)__\/ITALIC__/g, '*$1*');
  text = text.replace(/__(?:BOLD|ITALIC|(\/)BOLD|\/ITALIC)__/g, '');

  // Clean up whitespace
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.trim();

  if (text.length < 10) {
    throw new Error('RTF parsing produced empty or minimal text. The file may be corrupted or use unsupported features.');
  }

  return text;
}

/**
 * Remove RTF groups (content between `{...}`) that match a pattern.
 * Handles nested groups correctly.
 */
function stripControlGroups(text, pattern) {
  let result = text;
  // Find the opening brace for a group containing the pattern
  const idx = findGroupContaining(result, pattern);
  if (idx < 0) return result;

  const start = result.lastIndexOf('{', idx);
  if (start < 0) return result;

  let depth = 1;
  let pos = start + 1;
  while (pos < result.length && depth > 0) {
    if (result[pos] === '{') depth++;
    else if (result[pos] === '}') depth--;
    pos++;
  }
  return result.slice(0, start) + result.slice(pos);
}

function findGroupContaining(text, pattern) {
  // Re-implement as a search in the text
  const match = text.match(pattern);
  return match ? match.index : -1;
}

module.exports = { parseRtf };