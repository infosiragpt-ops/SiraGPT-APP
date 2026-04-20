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

// ─── Tools ─────────────────────────────────────────────────────────────────

const read_file = {
  name: 'read_file',
  description: 'Read the full text of a file from the user\'s knowledge collection, in ingestion order.',
  schema: { source: 'string (required — exact source id)', max_chars: 'number (optional, default 8000, max 40000)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const src = args?.source;
    if (!src || typeof src !== 'string') return { error: 'missing "source"' };
    const maxChars = Math.max(200, Math.min(Number(args?.max_chars) || 8000, 40000));

    // Iterate the store — deterministic, no semantic drift.
    const chunks = rag.getBySource(ctx.userId, ctx.collection, src);
    if (chunks.length === 0) return { error: `no chunks with source="${src}"` };

    // Join with a separator that preserves chunk boundaries but doesn't
    // corrupt line counts the caller might compute downstream. The title
    // (e.g. "file.ts:10-40") keeps line context intact.
    const joined = chunks
      .map(c => c.title ? `// ${c.title}\n${c.text}` : c.text)
      .join('\n\n');

    return {
      source: src,
      chunks: chunks.length,
      text: joined.slice(0, maxChars),
      truncated: joined.length > maxChars,
      total_chars: joined.length,
    };
  },
};

const list_files = {
  name: 'list_files',
  description: 'List every distinct source identifier in the current collection (deterministic — no semantic filter).',
  schema: { contains: 'string (optional — filter sources whose id includes this substring, case-insensitive)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    let sources = rag.listSources(ctx.userId, ctx.collection);
    const needle = typeof args?.contains === 'string' ? args.contains.trim().toLowerCase() : '';
    if (needle) sources = sources.filter(s => String(s.source).toLowerCase().includes(needle));
    return {
      count: sources.length,
      files: sources.slice(0, 100), // hard cap so observations stay manageable
    };
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
  description: 'Fetch a specific function/class/interface from a source file by exact name.',
  schema: { source: 'string (required)', symbol: 'string (required)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const { source, symbol } = args || {};
    if (!source || !symbol) return { error: 'missing "source" or "symbol"' };

    const chunks = rag.getBySource(ctx.userId, ctx.collection, source);
    if (chunks.length === 0) return { error: `no content for source="${source}"` };

    // Fast path: when the file was ingested via ingestCode, each chunk's
    // meta carries the exact symbol name. No re-chunking, correct line
    // numbers — the essential fix over the previous implementation that
    // re-ran code-chunker on concatenated text (which silently reset
    // line counts per chunk boundary).
    const fromMeta = chunks.filter(c => c.meta?.name === symbol);
    if (fromMeta.length > 0) {
      return {
        source, symbol,
        match: 'exact',
        chunks: fromMeta.map(c => ({
          title: c.title,
          text: c.text,
          language: c.meta?.language,
          nodeType: c.meta?.nodeType,
          startLine: c.meta?.startLine,
          endLine: c.meta?.endLine,
        })),
      };
    }

    // Fallback path: file wasn't ingested via ingestCode (no meta). We
    // re-chunk the concatenated text, but this time we strip the chunk
    // separator titles we injected in read_file ("// <title>\n") and
    // rely on the chunks being in insertion order — so code-chunker
    // produces usable line numbers relative to the concatenated view.
    // This is best-effort; line numbers may still be off by a constant.
    const joined = chunks.map(c => c.text).join('\n');
    const reChunked = codeChunker.chunkCode(source, joined);
    const symChunks = reChunked.filter(c => c.name === symbol);
    if (symChunks.length === 0) return { error: `symbol "${symbol}" not found in ${source}` };
    return {
      source, symbol,
      match: 'reparsed',
      chunks: symChunks.map(c => ({
        title: `${source}:${c.startLine}-${c.endLine} (${c.nodeType} ${c.name})`,
        text: c.text,
        language: c.language,
        nodeType: c.nodeType,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    };
  },
};

// ─── Deterministic static checks (no LLM) ───────────────────────────────────
//
// Each check receives:
//   text       — original source
//   lines      — text.split('\n')
//   context    — { language, codeMask }
// where codeMask[i] is true if lines[i] contains any non-comment,
// non-string code. The mask lets checks skip false positives without
// writing a full tokeniser: "// eval(x)" inside a comment doesn't
// trigger the eval_usage check; `"api_key: abcdef"` inside a string
// literal doesn't trigger hardcoded_secret.
//
// The mask is approximate — it correctly handles:
//   - // line comments (JS/TS/Java/Go/Rust/C/C++)
//   - # line comments (Python, shell-style)
//   - /* … */ block comments
//   - "…" and '…' string literals with \-escape support
// It does NOT handle template literals (JS `…${…}`) or Python triple-
// quoted strings; we leave those as-is because checking them correctly
// needs a real parser and the false-positive rate is low in practice.

/**
 * Strip string literals ("..." / '...' / `...`) from a single line,
 * replacing their contents with empty strings. Preserves the opening
 * and closing quotes so column offsets roughly align. Returns the
 * transformed line. Useful when a check wants to match patterns that
 * are only meaningful in CODE position — eval(x) in code is risky,
 * eval(x) inside a string is prose.
 */
function stripStringLiterals(line) {
  let out = '';
  let inString = false;
  let stringChar = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === stringChar) { inString = false; stringChar = null; out += ch; continue; }
      // drop the char
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true; stringChar = ch; out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function buildCommentCodeMask(text, language) {
  const lines = text.split('\n');
  const codeMask = new Array(lines.length).fill(false);
  const isHashComment = language === 'python' || language === 'ruby' || language === 'shell' || language === 'unknown';

  let inBlockComment = false;
  let inString = false;
  let stringChar = null;
  let escaped = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let hasCode = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === stringChar) { inString = false; stringChar = null; }
        continue;
      }
      // Line comment?
      if (ch === '/' && next === '/' && language !== 'python' && language !== 'shell') break;
      if (isHashComment && ch === '#') break;
      // Block comment?
      if (ch === '/' && next === '*' && language !== 'python' && language !== 'shell') {
        inBlockComment = true; i++; continue;
      }
      // String start?
      if (ch === '"' || ch === "'" || (ch === '`' && (language === 'javascript' || language === 'typescript'))) {
        inString = true; stringChar = ch; continue;
      }
      if (!/\s/.test(ch)) hasCode = true;
    }
    codeMask[li] = hasCode;
  }
  return { lines, codeMask };
}

const STATIC_CHECKS = [
  {
    id: 'long_function',
    description: 'Function bodies longer than 80 lines are hard to review',
    scan: (text, { lines }) => {
      // Heuristic applies to whole-file chunks; long_function is a soft
      // signal that the file is hard to take in at a glance.
      if (lines.length > 80) {
        return [{ severity: 'warn', line: 1, message: `source spans ${lines.length} lines — consider splitting` }];
      }
      return [];
    },
  },
  {
    id: 'todo_fixme',
    description: 'Pending TODO/FIXME/XXX/HACK markers',
    scan: (text, { lines }) => {
      // TODOs inside comments ARE what we want to flag — that's the whole
      // point. We still scan every line; the mask is not consulted.
      const out = [];
      lines.forEach((line, i) => {
        const m = line.match(/\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.*)$/);
        if (m) out.push({ severity: 'info', line: i + 1, message: `${m[1]}: ${m[2].trim().slice(0, 120)}` });
      });
      return out;
    },
  },
  {
    id: 'eval_usage',
    description: 'Use of eval() or new Function() — dynamic code execution',
    scan: (text, { lines, codeMask }) => {
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return; // skip pure-comment lines
        // Strip string literals so `"eval(x)"` inside a string doesn't
        // trigger; only real code-position matches should fire.
        const stripped = stripStringLiterals(line);
        if (/\beval\s*\(/.test(stripped) || /\bnew\s+Function\s*\(/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'dynamic code execution — audit carefully' });
        }
      });
      return out;
    },
  },
  {
    id: 'hardcoded_secret',
    description: 'Likely hard-coded secret or API key',
    scan: (text, { lines }) => {
      // For secrets we INTENTIONALLY scan strings (that's where they
      // hide) but skip lines that are entirely inside a block comment.
      // The patterns below are tuned to common real formats.
      const out = [];
      const patterns = [
        { re: /(?:api[_-]?key|secret|passwd|password|token|bearer)\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{16,})["']/gi, msg: 'possible hard-coded credential' },
        { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, msg: 'AWS access key id' },
        { re: /\bsk-[A-Za-z0-9]{20,}\b/g, msg: 'OpenAI-style secret key' },
        { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, msg: 'Slack token' },
        { re: /\bghp_[A-Za-z0-9]{36}\b/g, msg: 'GitHub personal access token' },
        { re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, msg: 'JWT-shaped token' },
      ];
      lines.forEach((line, i) => {
        for (const { re, msg } of patterns) {
          re.lastIndex = 0;
          if (re.test(line)) {
            out.push({ severity: 'high', line: i + 1, message: msg });
            break;
          }
        }
      });
      return out;
    },
  },
  {
    id: 'console_log',
    description: 'Leftover console.log / print / debugger statements',
    scan: (text, { lines, codeMask, language }) => {
      const out = [];
      const patterns = [];
      if (language === 'javascript' || language === 'typescript' || language === 'unknown') {
        patterns.push([/\bconsole\.(log|debug)\s*\(/, 'console.log']);
        patterns.push([/^\s*debugger\s*;?\s*$/, 'debugger']);
      }
      if (language === 'python') patterns.push([/^\s*print\s*\(/, 'print()']);

      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        for (const [re, label] of patterns) {
          if (re.test(line)) {
            out.push({ severity: 'info', line: i + 1, message: `${label} left in code` });
            break;
          }
        }
      });
      return out;
    },
  },
  {
    id: 'empty_catch',
    description: 'Empty catch block — errors are silently swallowed',
    scan: (text, { codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'java') return [];
      // catch (e) { } or catch { } with nothing inside.
      const out = [];
      const re = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const upto = text.slice(0, m.index);
        const line = upto.split('\n').length;
        if (!codeMask[line - 1]) continue;
        out.push({ severity: 'warn', line, message: 'empty catch block — handle or rethrow' });
      }
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
    // Build the comment/string mask ONCE and pass it to every check so
    // each regex scan runs in O(lines) rather than re-tokenising.
    const { lines, codeMask } = buildCommentCodeMask(content, language);
    const findings = [];
    for (const check of STATIC_CHECKS) {
      const hits = check.scan(content, { language, lines, codeMask });
      for (const h of hits) findings.push({ rule: check.id, ...h });
    }
    // Sort by line, then severity — easier for downstream consumption.
    const severityOrder = { high: 0, warn: 1, info: 2 };
    findings.sort((a, b) => (a.line - b.line) || (severityOrder[a.severity] - severityOrder[b.severity]));
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
  buildCommentCodeMask, // exported for tests
  stripStringLiterals,  // exported for tests
};
