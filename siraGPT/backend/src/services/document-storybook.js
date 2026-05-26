'use strict';

/**
 * document-storybook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Storybook CSF (Component Story Format) constructs:
 *
 *   - Default export (Meta):  export default { title, component, args, ... }
 *   - Story exports:          export const Primary: Story = { args: ... }
 *   - args / argTypes / parameters / decorators / play functions
 *   - Imports from '@storybook/react' or similar
 *   - StoryFn / StoryObj / Meta type imports
 *
 * Public API:
 *   extractStorybook(text)             → { entries, totals, total }
 *   buildStorybookForFiles(files)      → { perFile, aggregate, totals }
 *   renderStorybookBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const META_RE = /\bexport\s+default\s+(?:\{|<[A-Z]|[a-zA-Z_][a-zA-Z0-9_]{0,40}\s*(?:;|satisfies)|satisfies\s+Meta)/g;
const TITLE_RE = /\btitle\s*:\s*["'`]([^"'`\n]{1,120})["'`]/g;
const COMPONENT_RE = /\bcomponent\s*:\s*([A-Z][A-Za-z0-9_$]{1,60})/g;
const STORY_EXPORT_RE = /\bexport\s+const\s+([A-Z][A-Za-z0-9_]{0,60})(?:\s*:\s*(?:Story|StoryObj|StoryFn|ComponentStory))?\s*=\s*(?:\{|<|\()/g;
const ARGS_RE = /\bargs\s*:\s*\{/g;
const ARGTYPES_RE = /\bargTypes\s*:\s*\{/g;
const PARAMETERS_RE = /\bparameters\s*:\s*\{/g;
const DECORATORS_RE = /\bdecorators\s*:\s*\[/g;
const PLAY_RE = /\bplay\s*:\s*async\s+\(\s*\{|\bplay\s*:\s*async\s*\(/g;
const SB_IMPORT_RE = /from\s+["']@storybook\/([a-z][a-zA-Z0-9-]{1,30})["']/g;
const TYPE_IMPORT_RE = /\bimport\s+type\s+\{\s*([^}]{1,200})\s*\}\s+from\s+["']@storybook/g;

function isStorybookLike(body) {
  return /from\s+["']@storybook\/|export\s+const\s+[A-Z][A-Za-z0-9_]*\s*:\s*(?:Story|StoryObj|Meta)|export\s+default\s+\{[^}]*title\s*:/.test(body);
}

function extractStorybook(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isStorybookLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    meta: 0, title: 0, component: 0, story: 0,
    args: 0, argTypes: 0, parameters: 0, decorators: 0, play: 0,
    sbImport: 0, typeImport: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  let metaCount = 0;
  META_RE.lastIndex = 0;
  while (META_RE.exec(body) && metaCount < 5) metaCount += 1;
  totals.meta = metaCount;
  if (metaCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'meta', name: 'default-export', detail: `${metaCount}` });
  }

  let m;
  TITLE_RE.lastIndex = 0;
  while ((m = TITLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('title', m[1].slice(0, 80), null);
  }
  if (entries.length < MAX_PER_FILE) {
    COMPONENT_RE.lastIndex = 0;
    while ((m = COMPONENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('component', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STORY_EXPORT_RE.lastIndex = 0;
    while ((m = STORY_EXPORT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('story', m[1], null);
    }
  }

  let argsCount = 0;
  ARGS_RE.lastIndex = 0;
  while (ARGS_RE.exec(body) && argsCount < 50) argsCount += 1;
  totals.args = argsCount;

  let argTypesCount = 0;
  ARGTYPES_RE.lastIndex = 0;
  while (ARGTYPES_RE.exec(body) && argTypesCount < 20) argTypesCount += 1;
  totals.argTypes = argTypesCount;

  let parametersCount = 0;
  PARAMETERS_RE.lastIndex = 0;
  while (PARAMETERS_RE.exec(body) && parametersCount < 20) parametersCount += 1;
  totals.parameters = parametersCount;

  let decoratorsCount = 0;
  DECORATORS_RE.lastIndex = 0;
  while (DECORATORS_RE.exec(body) && decoratorsCount < 20) decoratorsCount += 1;
  totals.decorators = decoratorsCount;

  let playCount = 0;
  PLAY_RE.lastIndex = 0;
  while (PLAY_RE.exec(body) && playCount < 30) playCount += 1;
  totals.play = playCount;
  if (playCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'play', name: 'play function', detail: `${playCount}` });
  }

  if (entries.length < MAX_PER_FILE) {
    SB_IMPORT_RE.lastIndex = 0;
    while ((m = SB_IMPORT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('sbImport', `@storybook/${m[1]}`, null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildStorybookForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    meta: 0, title: 0, component: 0, story: 0,
    args: 0, argTypes: 0, parameters: 0, decorators: 0, play: 0,
    sbImport: 0, typeImport: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractStorybook(txt);
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

function renderStorybookBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## STORYBOOK CSF'];
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
  extractStorybook,
  buildStorybookForFiles,
  renderStorybookBlock,
  _internal: { isStorybookLike },
};
