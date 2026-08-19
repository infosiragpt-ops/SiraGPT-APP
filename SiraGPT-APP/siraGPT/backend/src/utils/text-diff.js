'use strict';

/**
 * text-diff — line-based diff via Longest Common Subsequence. Pairs
 * with deepDiff (#63) for structured-data diffs and JSON Patch (#66)
 * for object-shape patches; this one is for plain-text snapshots:
 * audit-log narration, prompt edits, file change reviews.
 *
 * O(n*m) memory: fine for short documents (chat-history-sized
 * snapshots). For multi-MB files use a real diff library.
 *
 * Public API:
 *   diffLines(a, b)
 *     → [{ kind: 'eq'|'add'|'del', value }] in original order
 *
 *   unifiedDiff(a, b, { aLabel, bLabel, contextLines = 3 })
 *     → string in classic patch(1) format
 */

function splitLines(text) {
  if (typeof text !== 'string' || !text) return [];
  // Keep an ending element when the text doesn't end with a newline so
  // we can round-trip the trailing line.
  return text.split('\n');
}

function lcsTable(a, b) {
  const n = a.length, m = b.length;
  const tbl = new Array(n + 1);
  for (let i = 0; i <= n; i++) tbl[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) tbl[i][j] = tbl[i - 1][j - 1] + 1;
      else tbl[i][j] = Math.max(tbl[i - 1][j], tbl[i][j - 1]);
    }
  }
  return tbl;
}

function diffLines(a, b) {
  const aLines = Array.isArray(a) ? a : splitLines(a);
  const bLines = Array.isArray(b) ? b : splitLines(b);
  if (aLines.length === 0 && bLines.length === 0) return [];
  if (aLines.length === 0) return bLines.map((v) => ({ kind: 'add', value: v }));
  if (bLines.length === 0) return aLines.map((v) => ({ kind: 'del', value: v }));

  const tbl = lcsTable(aLines, bLines);
  const out = [];
  let i = aLines.length, j = bLines.length;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      out.push({ kind: 'eq', value: aLines[i - 1] });
      i--; j--;
    } else if (tbl[i - 1][j] > tbl[i][j - 1]) {
      out.push({ kind: 'del', value: aLines[i - 1] });
      i--;
    } else {
      // Tie or add path. Emitting 'add' here makes the reversed walk
      // place 'del' before 'add' at each mismatch (conventional
      // unified-diff order).
      out.push({ kind: 'add', value: bLines[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.push({ kind: 'del', value: aLines[i - 1] }); i--; }
  while (j > 0) { out.push({ kind: 'add', value: bLines[j - 1] }); j--; }
  return out.reverse();
}

function buildHunks(diff, context) {
  // Group runs of changes with `context` lines on each side.
  const hunks = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].kind === 'eq') { i += 1; continue; }
    // Found change run start. Include preceding context.
    const start = Math.max(0, i - context);
    let end = i;
    while (end < diff.length) {
      if (diff[end].kind !== 'eq') { end += 1; continue; }
      // Look ahead: extend if another change is within `context` lines.
      let probe = end;
      let runStart = -1;
      while (probe < diff.length && (probe - end) < context * 2 + 1) {
        if (diff[probe].kind !== 'eq') { runStart = probe; break; }
        probe += 1;
      }
      if (runStart === -1) break;
      end = runStart + 1;
    }
    end = Math.min(diff.length, end + context);
    hunks.push(diff.slice(start, end));
    i = end;
  }
  return hunks;
}

function hunkHeader(hunkLines, aOffset, bOffset) {
  let aCount = 0, bCount = 0;
  for (const r of hunkLines) {
    if (r.kind === 'eq') { aCount += 1; bCount += 1; }
    else if (r.kind === 'del') aCount += 1;
    else if (r.kind === 'add') bCount += 1;
  }
  return `@@ -${aOffset + 1},${aCount} +${bOffset + 1},${bCount} @@`;
}

function unifiedDiff(a, b, { aLabel = 'a', bLabel = 'b', contextLines = 3 } = {}) {
  const diff = diffLines(a, b);
  if (diff.every((r) => r.kind === 'eq')) return '';
  const hunks = buildHunks(diff, contextLines);
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  // Compute offsets per hunk by counting kinds in preceding diff entries.
  let aIdx = 0, bIdx = 0, hunkStart = 0;
  for (const hunk of hunks) {
    // Find where this hunk starts in the original diff.
    while (hunkStart < diff.length && diff[hunkStart] !== hunk[0]) {
      if (diff[hunkStart].kind === 'eq') { aIdx += 1; bIdx += 1; }
      else if (diff[hunkStart].kind === 'del') aIdx += 1;
      else if (diff[hunkStart].kind === 'add') bIdx += 1;
      hunkStart += 1;
    }
    out.push(hunkHeader(hunk, aIdx, bIdx));
    for (const r of hunk) {
      const prefix = r.kind === 'eq' ? ' ' : r.kind === 'del' ? '-' : '+';
      out.push(`${prefix}${r.value}`);
    }
  }
  return out.join('\n') + '\n';
}

module.exports = {
  diffLines,
  unifiedDiff,
  splitLines,
};
