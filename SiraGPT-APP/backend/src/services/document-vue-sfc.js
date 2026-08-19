'use strict';

/**
 * document-vue-sfc.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Vue Single-File Component (.vue) blocks and attributes:
 *
 *   - <template>, <script>, <style>, <i18n>, custom blocks
 *   - lang attribute: lang="ts" / lang="scss" / lang="pug"
 *   - script setup: <script setup>
 *   - style scoped / module: <style scoped> / <style module>
 *   - Composition API hooks: ref()/reactive()/computed()/watch()/onMounted()
 *   - defineProps / defineEmits / defineExpose / defineOptions
 *
 * Public API:
 *   extractVueSfc(text)             → { entries, totals, total }
 *   buildVueSfcForFiles(files)      → { perFile, aggregate, totals }
 *   renderVueSfcBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const BLOCK_OPEN_RE = /<(template|script|style|i18n|docs)(\s+[^>]{0,200})?>/g;
const SETUP_RE = /<script\b[^>]*\bsetup\b/g;
const SCOPED_RE = /<style\b[^>]*\bscoped\b/g;
const MODULE_RE = /<style\b[^>]*\bmodule\b/g;
const COMPOSITION_API_RE = /\b(ref|reactive|computed|watch|watchEffect|onMounted|onBeforeMount|onUnmounted|onUpdated|onBeforeUnmount|provide|inject|toRef|toRefs|nextTick|getCurrentInstance|useSlots|useAttrs)\s*\(/g;
const MACRO_RE = /\b(defineProps|defineEmits|defineExpose|defineOptions|defineModel|withDefaults|defineSlots)\s*[(<]/g;
const V_DIRECTIVE_RE = /\bv-(if|else-if|else|for|show|model|on|bind|slot|html|text|once|memo|pre|cloak)\b(?::[a-zA-Z][a-zA-Z0-9-]*)?/g;
const LANG_ATTR_RE = /<(template|script|style|i18n)\b[^>]*\blang\s*=\s*["']([a-z0-9+-]{1,20})["']/g;

function extractVueSfc(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  // Quick reject: must have <template> or <script setup> or some Vue-shape
  if (!/<template|<script\b|defineProps|defineEmits|v-(?:if|for|model|on|bind)/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const totals = {
    template: 0, script: 0, style: 0, i18n: 0, custom: 0,
    setup: 0, scoped: 0, cssModule: 0,
    compositionApi: 0, macro: 0, directive: 0, langAttr: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  BLOCK_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_OPEN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const tag = m[1];
    const kind = tag === 'docs' ? 'custom' : tag;
    push(kind, tag, m[2] ? m[2].trim().slice(0, 40) : null);
  }

  let setupCount = 0;
  SETUP_RE.lastIndex = 0;
  while (SETUP_RE.exec(body) && setupCount < 5) setupCount += 1;
  totals.setup = setupCount;
  if (setupCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'setup', name: '<script setup>', detail: `${setupCount} occurrence(s)` });
  }

  let scopedCount = 0;
  SCOPED_RE.lastIndex = 0;
  while (SCOPED_RE.exec(body) && scopedCount < 5) scopedCount += 1;
  totals.scoped = scopedCount;

  let moduleCount = 0;
  MODULE_RE.lastIndex = 0;
  while (MODULE_RE.exec(body) && moduleCount < 5) moduleCount += 1;
  totals.cssModule = moduleCount;

  if (entries.length < MAX_PER_FILE) {
    LANG_ATTR_RE.lastIndex = 0;
    while ((m = LANG_ATTR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('langAttr', `${m[1]} lang=${m[2]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COMPOSITION_API_RE.lastIndex = 0;
    while ((m = COMPOSITION_API_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('compositionApi', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MACRO_RE.lastIndex = 0;
    while ((m = MACRO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('macro', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    V_DIRECTIVE_RE.lastIndex = 0;
    while ((m = V_DIRECTIVE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('directive', m[0], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildVueSfcForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    template: 0, script: 0, style: 0, i18n: 0, custom: 0,
    setup: 0, scoped: 0, cssModule: 0,
    compositionApi: 0, macro: 0, directive: 0, langAttr: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractVueSfc(txt);
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

function renderVueSfcBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## VUE SFC STRUCTURE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` — ${e.detail}` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractVueSfc,
  buildVueSfcForFiles,
  renderVueSfcBlock,
};
