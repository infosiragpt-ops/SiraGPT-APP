'use strict';

/**
 * document-css-anim.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects CSS animations, transitions, and at-rules:
 *
 *   - @keyframes name { 0% {} 100% {} } and 'from'/'to' selectors
 *   - animation-name / animation-duration / animation-timing-function /
 *     animation-iteration-count / animation-direction / animation-fill-mode /
 *     animation-play-state / animation-delay
 *   - shorthand: animation: name 2s ease-in-out infinite
 *   - transition / transition-property / transition-duration
 *   - cubic-bezier() / steps() / linear() timing functions
 *   - @media (responsive) / @supports / @container
 *   - prefers-reduced-motion media query
 *
 * Public API:
 *   extractCssAnim(text)             → { entries, totals, total }
 *   buildCssAnimForFiles(files)      → { perFile, aggregate, totals }
 *   renderCssAnimBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const KEYFRAMES_RE = /@(?:-webkit-|-moz-|-ms-|-o-)?keyframes\s+([a-zA-Z_][a-zA-Z0-9_-]{0,60})\s*\{/g;
const ANIMATION_NAME_RE = /\banimation-name\s*:\s*([a-zA-Z_][a-zA-Z0-9_-]{0,60})/g;
const ANIMATION_SHORTHAND_RE = /\banimation\s*:\s*([a-zA-Z_][a-zA-Z0-9_-]{0,60})\s+(\d+(?:\.\d+)?(?:s|ms))/g;
const DURATION_RE = /\b(animation-duration|transition-duration)\s*:\s*([0-9.]+(?:s|ms)(?:\s*,\s*[0-9.]+(?:s|ms))*)/g;
const TIMING_RE = /\b(animation-timing-function|transition-timing-function|animation|transition)\s*:[^;]{1,200}?(cubic-bezier\([^)]{1,80}\)|steps\([^)]{1,60}\)|ease-in-out|ease-out|ease-in|step-start|step-end|linear|ease)/g;
const TRANSITION_PROP_RE = /\btransition-property\s*:\s*([a-zA-Z][a-zA-Z0-9-,\s]{0,200})/g;
const TRANSITION_SHORTHAND_RE = /\btransition\s*:\s*([a-zA-Z][a-zA-Z0-9-]{0,40})\s+(\d+(?:\.\d+)?(?:s|ms))/g;
const MEDIA_RE = /@media\s*\(([^)]{1,200})\)/g;
const SUPPORTS_RE = /@supports\s*\(([^)]{1,200})\)/g;
const CONTAINER_RE = /@container\s+(?:([a-zA-Z][a-zA-Z0-9_-]{0,60})\s+)?\(([^)]{1,100})\)/g;
const PREFERS_REDUCED_RE = /prefers-reduced-motion\s*:\s*(reduce|no-preference)/g;
const ITERATION_RE = /\banimation-iteration-count\s*:\s*([0-9]+(?:\.[0-9]+)?|infinite)/g;
const FILL_MODE_RE = /\banimation-fill-mode\s*:\s*(none|forwards|backwards|both)/g;

function isCssAnimLike(body) {
  return /@keyframes\b|\banimation(?:-name|-duration|-timing|-iteration|-fill|-delay|-direction)?\s*:|\btransition(?:-property|-duration|-timing|-delay)?\s*:|@media\s*\(|@supports\b|@container\b/.test(body);
}

function extractCssAnim(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isCssAnimLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    keyframes: 0, animation: 0, transition: 0, duration: 0,
    timing: 0, media: 0, supports: 0, container: 0,
    prefersReduced: 0, iteration: 0, fillMode: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  KEYFRAMES_RE.lastIndex = 0;
  let m;
  while ((m = KEYFRAMES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('keyframes', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    ANIMATION_NAME_RE.lastIndex = 0;
    while ((m = ANIMATION_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('animation', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ANIMATION_SHORTHAND_RE.lastIndex = 0;
    while ((m = ANIMATION_SHORTHAND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('animation', m[1], `duration: ${m[2]}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DURATION_RE.lastIndex = 0;
    while ((m = DURATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('duration', m[1], m[2].slice(0, 40));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TIMING_RE.lastIndex = 0;
    while ((m = TIMING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('timing', m[2].slice(0, 40), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TRANSITION_PROP_RE.lastIndex = 0;
    while ((m = TRANSITION_PROP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('transition', `property: ${m[1].trim().slice(0, 40)}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TRANSITION_SHORTHAND_RE.lastIndex = 0;
    while ((m = TRANSITION_SHORTHAND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('transition', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MEDIA_RE.lastIndex = 0;
    while ((m = MEDIA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('media', m[1].trim().slice(0, 60), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SUPPORTS_RE.lastIndex = 0;
    while ((m = SUPPORTS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('supports', m[1].trim().slice(0, 60), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CONTAINER_RE.lastIndex = 0;
    while ((m = CONTAINER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('container', m[1] || 'anonymous', m[2].trim().slice(0, 40));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PREFERS_REDUCED_RE.lastIndex = 0;
    while ((m = PREFERS_REDUCED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('prefersReduced', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ITERATION_RE.lastIndex = 0;
    while ((m = ITERATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('iteration', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FILL_MODE_RE.lastIndex = 0;
    while ((m = FILL_MODE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fillMode', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCssAnimForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    keyframes: 0, animation: 0, transition: 0, duration: 0,
    timing: 0, media: 0, supports: 0, container: 0,
    prefersReduced: 0, iteration: 0, fillMode: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCssAnim(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCssAnimBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CSS ANIMATIONS & AT-RULES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCssAnim,
  buildCssAnimForFiles,
  renderCssAnimBlock,
  _internal: { isCssAnimLike },
};
