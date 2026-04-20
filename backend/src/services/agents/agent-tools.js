/**
 * agent-tools — safe, read-only tool registry for SE agents.
 *
 * The survey (Liu et al., 2024) §5.1 treats Action (tools) as THE
 * component that extends an LLM's reach past its token output. Which
 * tools you expose defines what the agent can do. In a chat-app context
 * like siraGPT we deliberately avoid shell, network, and write tools:
 *   - No `run_command` / shell: a chat app is the wrong place to
 *     execute arbitrary code with user-level privileges.
 *   - No `write_file`: agents can propose diffs; applying them is the
 *     user's decision.
 *   - No outbound HTTP: prevents SSRF and data exfiltration.
 *
 * What agents CAN do through these tools:
 *   - read_file      — read a chunk already ingested into the user's
 *                      RAG collection (never the filesystem)
 *   - list_files     — enumerate chunks by source in a collection
 *   - search_docs    — hybrid RAG search (cosine + BM25 via RRF)
 *   - search_code    — BM25 over code chunks (identifier-preserving)
 *   - search_graph   — GEAR agent loop for multi-hop questions
 *   - get_symbol     — fetch a specific function/class from code-chunker output
 *   - static_checks  — deterministic structural lints (complexity,
 *                      long functions, TODOs, etc.)
 *   - propose_patch  — output-only structured diff proposal
 *
 * Each tool declares an OpenAPI-ish `schema` field that the agent-core
 * renders into the system prompt. Tool handlers are `(args, ctx) => obs`
 * where `ctx` carries userId + collection + the OpenAI client.
 */

const rag = require('../rag-service');
const bm25 = require('../bm25');
const codeChunker = require('../code-chunker');

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureCollection(ctx) {
  if (!ctx?.userId || !ctx?.collection) {
    throw new Error('tool requires ctx.userId and ctx.collection');
  }
}

// We expose a tiny view of the rag-service store via exported helpers so
// tools don't reach into its internals. If those helpers don't exist yet
// (older version of rag-service), we fall back gracefully.
function getCollectionEntries(ctx) {
  ensureCollection(ctx);
  // rag-service doesn't export entries directly, but stats + a careful
  // retrieval can reconstruct the set we need. For read_file + list_files
  // we do a broad retrieve with a high k and deduplicate by source.
  return null; // actual access done per-tool below via retrieve().
}

// ─── Tools ─────────────────────────────────────────────────────────────────

const read_file = {
  name: 'read_file',
  description: 'Read text of a file chunk from the user\'s knowledge collection by source identifier.',
  schema: { source: 'string (required)', max_chars: 'number (optional, default 4000)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const src = args?.source;
    if (!src || typeof src !== 'string') return { error: 'missing "source"' };
    const maxChars = Math.max(200, Math.min(Number(args?.max_chars) || 4000, 20000));

    // Retrieve with the source string itself as query — grabs chunks from
    // that source. Bounded at k=10 to avoid huge observations.
    const hits = await rag.retrieve(ctx.userId, ctx.collection, src, 10, { useHybrid: true });
    const filtered = hits.filter(h => h.source === src);
    if (filtered.length === 0) return { error: `no chunks with source="${src}"` };

    const joined = filtered.map(h => h.text).join('\n\n---\n\n');
    return {
      source: src,
      chunks: filtered.length,
      text: joined.slice(0, maxChars),
      truncated: joined.length > maxChars,
    };
  },
};

const list_files = {
  name: 'list_files',
  description: 'List distinct source identifiers in the current collection (up to 50).',
  schema: { query: 'string (optional — bias listing toward this topic)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const query = typeof args?.query === 'string' && args.query.trim()
      ? args.query.trim()
      : 'list all files';
    // Pull a wide net of hits, collapse by source.
    const hits = await rag.retrieve(ctx.userId, ctx.collection, query, 40, { useHybrid: true });
    const sources = new Map();
    for (const h of hits) {
      const s = h.source || '(no-source)';
      if (!sources.has(s)) sources.set(s, { source: s, title: h.title || null, preview: (h.text || '').slice(0, 120) });
    }
    return { count: sources.size, files: [...sources.values()].slice(0, 50) };
  },
};

const search_docs = {
  name: 'search_docs',
  description: 'Semantic + keyword hybrid search over the user\'s knowledge collection.',
  schema: { query: 'string (required)', k: 'number (optional, default 5)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    if (!args?.query) return { error: 'missing "query"' };
    const k = Math.max(1, Math.min(Number(args.k) || 5, 15));
    const hits = await rag.retrieve(ctx.userId, ctx.collection, args.query, k, {
      useHybrid: true, useExpansion: true,
    });
    return {
      hits: hits.map(h => ({
        source: h.source,
        title: h.title,
        snippet: (h.text || '').slice(0, 400),
        score: h.score,
      })),
    };
  },
};

const search_code = {
  name: 'search_code',
  description: 'BM25 keyword search over code chunks — best for exact identifier lookups like function names.',
  schema: { query: 'string (required — identifier or code phrase)', k: 'number (optional, default 5)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    if (!args?.query) return { error: 'missing "query"' };
    const k = Math.max(1, Math.min(Number(args.k) || 5, 15));
    // Retrieve a broad pool first, then apply BM25 for the final ranking.
    const broad = await rag.retrieve(ctx.userId, ctx.collection, args.query, 30, { useHybrid: true });
    const bmIndex = bm25.buildIndex(broad.map(h => ({ text: h.text, hit: h })));
    const ranked = bm25.searchIndex(bmIndex, args.query, { k });
    return {
      hits: ranked.map(r => ({
        source: r.doc.hit.source,
        title: r.doc.hit.title,
        snippet: (r.doc.hit.text || '').slice(0, 500),
        bm25: r.score,
      })),
    };
  },
};

const search_graph = {
  name: 'search_graph',
  description: 'Multi-hop GEAR retrieval — best for questions that need chaining facts across multiple sources.',
  schema: { query: 'string (required)', k: 'number (optional, default 5)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    if (!args?.query) return { error: 'missing "query"' };
    const k = Math.max(1, Math.min(Number(args.k) || 5, 15));
    // Single-hop SyncGE: cheaper than the full agent loop, good enough
    // for nested questions like "what team did X's father join".
    const hits = await rag.retrieve(ctx.userId, ctx.collection, args.query, k, {
      useHybrid: true, useGraph: true, graphOpenAI: ctx.openai || null,
    });
    return {
      hits: hits.map(h => ({
        source: h.source, title: h.title, score: h.score,
        snippet: (h.text || '').slice(0, 400),
      })),
    };
  },
};

const get_symbol = {
  name: 'get_symbol',
  description: 'Extract a specific function/class/interface from a source file by name.',
  schema: { source: 'string (required)', symbol: 'string (required)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const { source, symbol } = args || {};
    if (!source || !symbol) return { error: 'missing "source" or "symbol"' };

    // Pull chunks for that file and scan their metadata for the symbol.
    const hits = await rag.retrieve(ctx.userId, ctx.collection, symbol, 20, { useHybrid: true });
    const matching = hits.filter(h => h.source === source && h.title && h.title.includes(symbol));
    if (matching.length > 0) {
      return { source, symbol, chunks: matching.map(m => ({ title: m.title, text: m.text })) };
    }
    // Fallback: re-chunk the full file text via code-chunker if we have it.
    const allFromSource = hits.filter(h => h.source === source);
    if (allFromSource.length === 0) return { error: `no content for source="${source}"` };
    const joined = allFromSource.map(h => h.text).join('\n');
    const chunks = codeChunker.chunkCode(source, joined);
    const symChunks = chunks.filter(c => c.name && c.name === symbol);
    if (symChunks.length === 0) return { error: `symbol "${symbol}" not found in ${source}` };
    return {
      source, symbol,
      chunks: symChunks.map(c => ({
        title: `${source}:${c.startLine}-${c.endLine} (${c.nodeType} ${c.name})`,
        text: c.text,
        language: c.language,
      })),
    };
  },
};

// ─── Deterministic static checks (no LLM) ───────────────────────────────────

const STATIC_CHECKS = [
  {
    id: 'long_function',
    description: 'Function bodies longer than 80 lines are hard to review',
    scan: (text, { language }) => {
      const lines = text.split('\n');
      if (lines.length > 80) return [{ severity: 'warn', line: 1, message: `function spans ${lines.length} lines` }];
      return [];
    },
  },
  {
    id: 'todo_fixme',
    description: 'Pending TODO/FIXME/XXX markers',
    scan: (text) => {
      const out = [];
      text.split('\n').forEach((line, i) => {
        const m = line.match(/\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.*)$/);
        if (m) out.push({ severity: 'info', line: i + 1, message: `${m[1]}: ${m[2].trim().slice(0, 120)}` });
      });
      return out;
    },
  },
  {
    id: 'eval_usage',
    description: 'Use of eval() or new Function() is a security risk',
    scan: (text) => {
      const out = [];
      text.split('\n').forEach((line, i) => {
        if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'dynamic code execution — audit carefully' });
        }
      });
      return out;
    },
  },
  {
    id: 'hardcoded_secret',
    description: 'Likely hard-coded secret or API key',
    scan: (text) => {
      const out = [];
      const re = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']([A-Za-z0-9_\-]{16,})["']/gi;
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) {
          re.lastIndex = 0;
          out.push({ severity: 'high', line: i + 1, message: 'possible hard-coded credential' });
        }
        re.lastIndex = 0;
      });
      return out;
    },
  },
  {
    id: 'console_log',
    description: 'Leftover console.log / print / debugger statements',
    scan: (text, { language }) => {
      const out = [];
      const patterns = [
        [/console\.(log|debug)\s*\(/, 'console.log'],
        [/^\s*debugger\s*;?\s*$/, 'debugger'],
      ];
      if (language === 'python') patterns.push([/^\s*print\s*\(/, 'print()']);
      text.split('\n').forEach((line, i) => {
        for (const [re, label] of patterns) {
          if (re.test(line)) { out.push({ severity: 'info', line: i + 1, message: `${label} left in code` }); break; }
        }
      });
      return out;
    },
  },
];

const static_checks = {
  name: 'static_checks',
  description: 'Run deterministic structural lints on a source string. No network/shell.',
  schema: { source: 'string (required)', content: 'string (optional — if omitted, read from collection)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const src = args?.source;
    if (!src) return { error: 'missing "source"' };

    let content = args?.content;
    if (!content) {
      const fileObs = await read_file.handler({ source: src, max_chars: 200000 }, ctx);
      if (fileObs.error) return fileObs;
      content = fileObs.text;
    }

    const language = codeChunker.detectLanguage(src, content);
    const findings = [];
    for (const check of STATIC_CHECKS) {
      const hits = check.scan(content, { language });
      for (const h of hits) findings.push({ rule: check.id, ...h });
    }
    return {
      source: src,
      language,
      findings,
      counts: {
        high: findings.filter(f => f.severity === 'high').length,
        warn: findings.filter(f => f.severity === 'warn').length,
        info: findings.filter(f => f.severity === 'info').length,
      },
    };
  },
};

const propose_patch = {
  name: 'propose_patch',
  description: 'Output a structured patch suggestion. Does NOT apply changes — the user decides.',
  schema: { source: 'string (required)', start_line: 'number', end_line: 'number', replacement: 'string', rationale: 'string' },
  async handler(args /*, ctx */) {
    const { source, start_line, end_line, replacement, rationale } = args || {};
    if (!source || typeof replacement !== 'string') return { error: 'missing "source" or "replacement"' };
    return {
      proposed: true,
      source,
      start_line: Number(start_line) || null,
      end_line: Number(end_line) || null,
      replacement,
      rationale: rationale || '(no rationale provided)',
    };
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  read_file, list_files, search_docs, search_code, search_graph, get_symbol, static_checks, propose_patch,
];

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map(t => [t.name, t]));

function pick(names) {
  return names.map(n => TOOLS_BY_NAME.get(n)).filter(Boolean);
}

module.exports = {
  ALL_TOOLS,
  TOOLS_BY_NAME,
  pick,
  // individual exports for tests
  read_file, list_files, search_docs, search_code, search_graph, get_symbol, static_checks, propose_patch,
  STATIC_CHECKS,
};
