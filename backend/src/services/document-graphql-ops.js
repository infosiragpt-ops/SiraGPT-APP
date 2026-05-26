'use strict';

/**
 * document-graphql-ops.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GraphQL operation names (queries, mutations, subscriptions,
 * fragments) and tagged-template references (`gql\`query GetX { … }\``,
 * `apolloClient.query({ query: GET_USER })`).
 *
 * Targets:
 *   - SDL:       query GetUser($id: ID!) { … }
 *                mutation CreatePost($input: …) { … }
 *                subscription OnMessageReceived { … }
 *                fragment UserFields on User { … }
 *   - tagged:    gql`query GetX { … }`
 *                graphql`query GetX { … }`
 *   - constants: const GET_USER_QUERY = gql`…`
 *                const CREATE_POST_MUTATION = gql`…`
 *
 * Public API:
 *   extractGraphqlOps(text)            → { entries, totals, total }
 *   buildGraphqlOpsForFiles(files)     → { perFile, aggregate, totals }
 *   renderGraphqlOpsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const SDL_RE = /\b(query|mutation|subscription|fragment)\s+([A-Z][A-Za-z0-9_]{2,60})\b(?:\s+on\s+([A-Z][A-Za-z0-9_]{2,40}))?/g;
const CONST_RE = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]{3,50}_(?:QUERY|MUTATION|SUBSCRIPTION|FRAGMENT))\b/g;

const RESERVED = new Set(['Query', 'Mutation', 'Subscription', 'Schema', 'Type']);

function classifyKind(kw) {
  const lower = kw.toLowerCase();
  if (lower === 'query' || lower === 'mutation' || lower === 'subscription' || lower === 'fragment') return lower;
  return 'unknown';
}

function constantToKind(name) {
  if (/_QUERY$/.test(name)) return 'query';
  if (/_MUTATION$/.test(name)) return 'mutation';
  if (/_SUBSCRIPTION$/.test(name)) return 'subscription';
  if (/_FRAGMENT$/.test(name)) return 'fragment';
  return 'unknown';
}

function extractGraphqlOps(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { query: 0, mutation: 0, subscription: 0, fragment: 0 };

  // SDL operations
  SDL_RE.lastIndex = 0;
  let m;
  while ((m = SDL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const kind = classifyKind(m[1]);
    const name = m[2];
    const onType = m[3] || null;
    if (RESERVED.has(name)) continue;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind, name, onType, source: 'sdl' });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // Constant references
  if (entries.length < MAX_PER_FILE) {
    CONST_RE.lastIndex = 0;
    while ((m = CONST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const fullName = m[1];
      const kind = constantToKind(fullName);
      // Strip the trailing _QUERY/_MUTATION/etc to get the bare name
      const bareName = fullName.replace(/_(?:QUERY|MUTATION|SUBSCRIPTION|FRAGMENT)$/, '');
      const key = `${kind}:${bareName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, name: bareName, onType: null, source: 'constant' });
      if (totals[kind] != null) totals[kind] += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGraphqlOpsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { query: 0, mutation: 0, subscription: 0, fragment: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGraphqlOps(txt);
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

function renderGraphqlOpsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GRAPHQL OPERATIONS'];
  const t = report.totals || {};
  const parts = [];
  if (t.query) parts.push(`query: ${t.query}`);
  if (t.mutation) parts.push(`mutation: ${t.mutation}`);
  if (t.subscription) parts.push(`subscription: ${t.subscription}`);
  if (t.fragment) parts.push(`fragment: ${t.fragment}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const onClause = e.onType ? ` on ${e.onType}` : '';
      lines.push(`- ${e.kind} \`${e.name}\`${onClause} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGraphqlOps,
  buildGraphqlOpsForFiles,
  renderGraphqlOpsBlock,
  _internal: { classifyKind, constantToKind },
};
