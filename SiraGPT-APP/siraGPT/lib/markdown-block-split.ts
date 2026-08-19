// Split a partially-streamed markdown string into a "stable head"
// (the prefix that is guaranteed not to change as more tokens arrive)
// and a "live tail" (the in-flight block at the end).
//
// We cut on a blank-line boundary that lies OUTSIDE of:
//   - a fenced code block (``` ... ``` or ~~~ ... ~~~)
//   - a `:::` directive container (e.g. `:::note ... :::`)
//
// This means the head can hold finished paragraphs, lists, tables, and
// closed code/callout blocks, while only the last open block keeps
// re-rendering as new chunks arrive. Tables and lists don't have blank
// lines mid-block under common markdown, so the simple "split on \n\n
// outside fence/directive" rule keeps them intact.

export type MarkdownSplit = { head: string; tail: string };

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
const DIRECTIVE_OPEN_RE = /^\s*:::[A-Za-z][\w-]*/;
const DIRECTIVE_CLOSE_RE = /^\s*:::\s*$/;

export function splitStableHead(content: string): MarkdownSplit {
  if (!content || content.length < 64) {
    // Too short to bother — let the live renderer handle the whole thing.
    return { head: '', tail: content };
  }

  const lines = content.split('\n');
  let inFence = false;
  let fenceMarker: string | null = null;
  let directiveDepth = 0;

  // Last line index (inclusive) that is safe to put in the head.
  // We track it as the index of the blank line that closes a block.
  let lastSafeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFence) {
      // Look for the matching closing fence.
      const trimmed = line.trimStart();
      if (fenceMarker && trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[2];
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

    // A blank line outside any container is a safe cut point.
    if (directiveDepth === 0 && line.trim() === '') {
      lastSafeIdx = i;
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
