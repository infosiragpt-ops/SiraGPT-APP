import { closesCodeFence, openingCodeFence, type MarkdownFence } from "./markdown/code-regions";

// Split a partially-streamed markdown string into a "stable head"
// (the prefix that is guaranteed not to change as more tokens arrive)
// and a "live tail" (the in-flight block at the end).
//
// We cut on a blank-line boundary that lies OUTSIDE of:
//   - a fenced code block (``` ... ``` or ~~~ ... ~~~)
//   - a `:::` directive container (e.g. `:::note ... :::`)
//   - display math or blank-separated list items
//
// A blank line only counts once the next non-blank line starts at column 0:
// an indented line after it continues the previous list item (or a nested
// list / indented block), and cutting there would render the tail on its own
// as a stray paragraph or an indented code block until the next blank line.
//
// This means the head can hold finished paragraphs, lists, tables, and
// closed code/callout blocks, while only the last open block keeps
// re-rendering as new chunks arrive. Document-wide definitions and raw HTML
// stay in one parser because their semantics can cross block boundaries.

export type MarkdownSplit = { head: string; tail: string };

const LIST_ITEM_RE = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const DIRECTIVE_OPEN_RE = /^\s*:::[A-Za-z][\w-]*/;
const DIRECTIVE_CLOSE_RE = /^\s*:::\s*$/;

export function splitStableHead(content: string): MarkdownSplit {
  if (!content || content.length < 64) {
    // Too short to bother — let the live renderer handle the whole thing.
    return { head: '', tail: content };
  }

  // References (including footnotes) are document-wide. A second parser
  // cannot resolve definitions in the other half. Raw HTML containers can
  // also span blank lines, so keep these less common messages as one tree.
  if (/^[ \t]{0,3}\[[^\]\n]+\]:/m.test(content) || /^[ \t]{0,3}<(?:[A-Za-z][\w-]*[\s>]|!--)/m.test(content)) {
    return { head: '', tail: content };
  }

  const lines = content.split('\n');
  let fence: MarkdownFence | null = null;
  let mathFenceLength = 0;
  let inList = false;
  let directiveDepth = 0;

  // Last line index (inclusive) that is safe to put in the head.
  // We track it as the index of the blank line that closes a block.
  let lastSafeIdx = -1;
  // Blank line waiting for the next non-blank line to decide whether it is a
  // real block boundary (column-0 line) or sits inside a list item (indented).
  let pendingBlank = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      if (closesCodeFence(line, fence)) fence = null;
      continue;
    }
    if (mathFenceLength > 0) {
      const close = /^[ \t]*([\$]{2,})[ \t]*$/.exec(line);
      if (close && close[1].length >= mathFenceLength) mathFenceLength = 0;
      continue;
    }

    // A blank line is a safe cut only once the next non-blank line starts at
    // column 0; indented lines continue the previous list item or container.
    if (line.trim() === '') {
      if (directiveDepth === 0) pendingBlank = i;
      continue;
    }
    const isListItem = LIST_ITEM_RE.test(line);
    if (pendingBlank >= 0 && /^\S/.test(line)) {
      // Blank-separated items still belong to the same loose list. Splitting
      // here resets numbering and changes paragraph spacing during streaming.
      if (!(inList && isListItem)) lastSafeIdx = pendingBlank;
      if (!isListItem) inList = false;
    }
    pendingBlank = -1;
    if (isListItem) inList = true;

    fence = openingCodeFence(line);
    if (fence) continue;

    const mathOpen = /^[ \t]*([\$]{2,})[ \t]*$/.exec(line);
    if (mathOpen) {
      mathFenceLength = mathOpen[1].length;
      continue;
    }

    if (DIRECTIVE_OPEN_RE.test(line)) {
      directiveDepth++;
      continue;
    }
    if (directiveDepth > 0 && DIRECTIVE_CLOSE_RE.test(line)) {
      directiveDepth--;
      continue;
    }
  }

  if (lastSafeIdx <= 0) {
    return { head: '', tail: content };
  }

  // Include the blank line itself in the head so the tail starts cleanly.
  const headLines = lines.slice(0, lastSafeIdx + 1);
  const tailLines = lines.slice(lastSafeIdx + 1);
  const head = headLines.join('\n');
  const tail = tailLines.join('\n');

  // Guard against pathological "head is everything, tail is empty" — let
  // the caller render the head as the closed message instead.
  return { head, tail };
}
