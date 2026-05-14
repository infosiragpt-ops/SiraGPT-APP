'use strict';

/**
 * document-ml-models.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects AI / ML model identifiers across major providers. Useful for routing
 * "which model are we calling?" / "show me every Claude 4 reference" / "what
 * fine-tunes are mentioned?" without depending on a global model index.
 *
 * Targets:
 *   - OpenAI:     gpt-4, gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o1-preview,
 *                 o3, o3-mini, text-embedding-3-small/large
 *   - Anthropic:  claude-3-opus, claude-3-5-sonnet, claude-opus-4, claude-opus-4-7,
 *                 claude-sonnet-4-6, claude-haiku-4-5, claude-3-7-sonnet
 *   - Google:     gemini-pro, gemini-1.5-pro, gemini-2.0-flash, gemini-2.5-pro,
 *                 text-bison, palm-2
 *   - Meta:       llama-2, llama-3, llama-3.1-405b, llama-3.2-90b, llama-3.3
 *   - Mistral:    mistral-large, mistral-medium, mistral-small, mixtral-8x7b,
 *                 mixtral-8x22b, codestral
 *   - DeepSeek:   deepseek-v3, deepseek-r1, deepseek-coder
 *   - Qwen:       qwen-2.5, qwen-2.5-coder, qwen2.5-72b
 *   - Embedding-only: text-embedding-3-*, voyage-3, cohere-embed-v3
 *
 * Public API:
 *   extractMlModels(text)            → { entries, totals, total }
 *   buildMlModelsForFiles(files)     → { perFile, aggregate, totals }
 *   renderMlModelsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

// Each entry: regex → { provider, kind }
const MODEL_PATTERNS = [
  // OpenAI
  { re: /\b(gpt-4o(?:-mini|-realtime|-audio)?(?:-\d{4}-\d{2}-\d{2})?)\b/gi, provider: 'openai', kind: 'chat' },
  { re: /\b(gpt-4-turbo(?:-\d{4}-\d{2}-\d{2}|-preview)?)\b/gi, provider: 'openai', kind: 'chat' },
  { re: /\b(gpt-4(?:-\d{4})?)\b/gi, provider: 'openai', kind: 'chat' },
  { re: /\b(gpt-3\.5-turbo(?:-\d{4})?)\b/gi, provider: 'openai', kind: 'chat' },
  { re: /\b(o1-(?:preview|mini)?|o1)\b/gi, provider: 'openai', kind: 'reasoning' },
  { re: /\b(o3-mini|o3)\b/gi, provider: 'openai', kind: 'reasoning' },
  { re: /\b(text-embedding-3-(?:small|large)|text-embedding-ada-002)\b/gi, provider: 'openai', kind: 'embedding' },
  // Anthropic
  { re: /\b(claude-(?:opus|sonnet|haiku)-[34][-.]?\d*(?:-\d+)?(?:-\d{8})?)\b/gi, provider: 'anthropic', kind: 'chat' },
  { re: /\b(claude-3-(?:opus|sonnet|haiku)(?:-\d{8})?)\b/gi, provider: 'anthropic', kind: 'chat' },
  { re: /\b(claude-3-5-sonnet(?:-\d{8})?)\b/gi, provider: 'anthropic', kind: 'chat' },
  { re: /\b(claude-3-7-sonnet(?:-\d{8})?)\b/gi, provider: 'anthropic', kind: 'chat' },
  // Google
  { re: /\b(gemini-(?:1\.5|2\.0|2\.5)-(?:pro|flash|nano)(?:-\d{3})?)\b/gi, provider: 'google', kind: 'chat' },
  { re: /\b(gemini-pro)\b/gi, provider: 'google', kind: 'chat' },
  { re: /\b(text-bison-\d{3}|palm-2)\b/gi, provider: 'google', kind: 'chat' },
  // Meta / Llama
  { re: /\b(llama-?(?:2|3|3\.1|3\.2|3\.3)-(?:\d+b)(?:-instruct|-chat|-vision)?)\b/gi, provider: 'meta', kind: 'chat' },
  // Mistral
  { re: /\b(mistral-(?:large|medium|small|nemo)(?:-\d{4})?)\b/gi, provider: 'mistral', kind: 'chat' },
  { re: /\b(mixtral-8x(?:7|22)b)\b/gi, provider: 'mistral', kind: 'chat' },
  { re: /\b(codestral(?:-\d+)?)\b/gi, provider: 'mistral', kind: 'code' },
  // DeepSeek
  { re: /\b(deepseek-(?:v3|r1|coder|chat))\b/gi, provider: 'deepseek', kind: 'chat' },
  // Qwen
  { re: /\b(qwen-?2\.5(?:-\d+b)?(?:-coder|-instruct)?)\b/gi, provider: 'qwen', kind: 'chat' },
  // Embeddings (cross-vendor)
  { re: /\b(voyage-\d+|cohere-embed-v\d)\b/gi, provider: 'cohere/voyage', kind: 'embedding' },
];

function extractMlModels(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  for (const { re, provider, kind } of MODEL_PATTERNS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const id = m[1].toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, provider, kind });
      const key = `${provider}/${kind}`;
      totals[key] = (totals[key] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMlModelsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMlModels(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.id)) continue;
      aggSeen.add(e.id);
      aggregate.push(e);
      const key = `${e.provider}/${e.kind}`;
      totals[key] = (totals[key] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderMlModelsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## AI / ML MODELS'];
  const t = report.totals || {};
  const keys = Object.keys(t);
  if (keys.length) {
    const parts = keys.map((k) => `${k}: ${t[k]}`).slice(0, 8);
    lines.push(`- Totals: ${parts.join(', ')}`);
  }
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- \`${e.id}\` (${e.provider} ${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMlModels,
  buildMlModelsForFiles,
  renderMlModelsBlock,
};
