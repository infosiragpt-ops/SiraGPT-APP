/**
 * agent-tools — safe, read-only tool registry for SE agents.
 *
 * The survey (Liu et al., 2024) §5.1 treats Action (tools) as THE
 * component that extends an LLM's reach past its token output. Which
 * tools you expose defines what the agent can do. In a chat-app context
 * like siraGPT we deliberately avoid shell and write tools:
 *   - No `run_command` / shell: a chat app is the wrong place to
 *     execute arbitrary code with user-level privileges.
 *   - No `write_file`: agents can propose diffs; applying them is the
 *     user's decision.
 *   - Outbound HTTP is limited to hardened web_search/read_url/web_extract
 *     adapters with SSRF, robots.txt, redirect and timeout controls.
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
 *   - web_search / web_extract — safe public-web research and scraping
 *   - session_search / session_list / session_history — user-owned
 *                      conversation continuity (search → browse → resume)
 *   - browser_*     — browser automation only when the caller injects a driver
 *
 * Each tool declares an OpenAPI-ish `schema` field that the agent-core
 * renders into the system prompt. Tool handlers are `(args, ctx) => obs`
 * where `ctx` carries userId + collection + the OpenAI client.
 */

const rag = require('../rag-service');
const bm25 = require('../bm25');
const codeChunker = require('../code-chunker');
const gearAgent = require('../gear-agent');
const webSearch = require('./web-search');

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureCollection(ctx) {
  if (!ctx?.userId || !ctx?.collection) {
    throw new Error('tool requires ctx.userId and ctx.collection');
  }
}

function safeBrowserRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const args = record.action === 'type'
    ? {
        selector: record.args?.selector,
        textLength: String(record.args?.text || '').length,
      }
    : record.args;
  return { ...record, args };
}

function slimScreenshot(screenshot) {
  if (!screenshot || typeof screenshot !== 'object') return null;
  return {
    id: screenshot.id || null,
    mime: screenshot.mime || null,
    bytes: Number.isFinite(Number(screenshot.bytes)) ? Number(screenshot.bytes) : null,
  };
}

function resolveBrowserAgent(ctx = {}) {
  if (ctx?.browserAgent && typeof ctx.browserAgent.run === 'function') {
    return ctx.browserAgent;
  }

  let driver = null;
  if (ctx?.browserDriver && typeof ctx.browserDriver.run === 'function') {
    driver = ctx.browserDriver;
  } else if (ctx?.browserAdapter && typeof ctx.browserAdapter.driver === 'function') {
    driver = ctx.browserAdapter.driver();
  } else if (ctx?.browser && typeof ctx.browser.driver === 'function') {
    driver = ctx.browser.driver();
  } else if (ctx?.browser && typeof ctx.browser.run === 'function') {
    driver = ctx.browser;
  }

  if (!driver || typeof driver.run !== 'function') return null;

  // eslint-disable-next-line global-require
  const { createBrowserAgent, DEFAULT_POLICY } = require('../ai-product-os/browser-agent');
  const agent = createBrowserAgent({
    driver,
    policy: ctx.browserPolicy || DEFAULT_POLICY,
  });
  if (ctx && typeof ctx === 'object') ctx.browserAgent = agent;
  return agent;
}

async function runBrowserAction(action, args = {}, ctx = {}) {
  try {
    const browserAgent = resolveBrowserAgent(ctx);
    if (!browserAgent) {
      return {
        ok: false,
        action,
        error: 'browser_driver_required',
        message: 'No active browser driver/session is available for browser automation.',
      };
    }
    const out = await browserAgent.run(action, args);
    return {
      ok: true,
      action,
      record: safeBrowserRecord(out?.record),
      result: out?.result || null,
      screenshot: slimScreenshot(out?.screenshot),
    };
  } catch (err) {
    return {
      ok: false,
      action,
      error: err?.code || 'browser_action_failed',
      message: String(err?.message || err).slice(0, 300),
    };
  }
}

// ─── Tools ─────────────────────────────────────────────────────────────────

// Pick the right comment prefix for a given source so the concatenated
// chunk output is syntactically valid for that language. Previously we
// always used `//`, which is a syntax error in Python/shell and
// disruptive in YAML/JSON/HTML.
function commentPrefixFor(source) {
  const ext = typeof source === 'string' && source.includes('.')
    ? source.split('.').pop().toLowerCase()
    : '';
  switch (ext) {
    case 'py': case 'rb': case 'sh': case 'bash': case 'zsh':
    case 'yaml': case 'yml': case 'toml': case 'conf':
    case 'r': case 'jl': case 'pl': case 'pm':
    case 'dockerfile': case 'gitignore': case 'gitconfig':
      return '#';
    case 'html': case 'htm': case 'xml': case 'svg':
    case 'md': case 'markdown':
      return '<!--';
    case 'css': case 'scss': case 'less':
      return '/*';
    case 'sql':
    case 'hs': case 'lua': case 'ada':
      return '--';
    case 'lisp': case 'clj': case 'scm': case 'el':
      return ';;';
    case 'tex': case 'latex': case 'matlab':
      // intentionally NOT 'm' — collides with Objective-C which uses //
      return '%';
    case 'bat': case 'cmd':
      return 'REM';
    case 'json': case 'jsonc':
      // JSON has no comment syntax. Returning a special marker so
      // formatChunkSeparator can drop the title entirely instead of
      // injecting `// title` into a payload that may later be parsed.
      return '';
    default:
      return '//'; // JS/TS/Go/Rust/Java/C/C++/Swift/Kotlin/etc.
  }
}

function formatChunkSeparator(prefix, title) {
  if (prefix === '<!--') return `<!-- ${title} -->`;
  if (prefix === '/*')   return `/* ${title} */`;
  if (!prefix)           return ''; // languages with no comment syntax (JSON)
  return `${prefix} ${title}`;
}

// Join a source's ingested chunks back into a single document string, in
// ingestion order, re-inserting the comment-style separators read_file uses.
// Shared by read_file (40k display cap) and static_checks (200k scan cap) so
// both reconstruct the file identically.
function joinSourceChunks(chunks, src) {
  const prefix = commentPrefixFor(src);
  return chunks
    .map(c => {
      if (!c.title) return c.text;
      const sep = formatChunkSeparator(prefix, c.title);
      return sep ? `${sep}\n${c.text}` : c.text;
    })
    .join('\n\n');
}

const read_file = {
  name: 'read_file',
  description: 'Read the full text of a file from the user\'s knowledge collection, in ingestion order.',
  schema: { source: 'string (required — exact source id)', max_chars: 'number (optional, default 8000, max 40000)' },
  async handler(args, ctx) {
    ensureCollection(ctx);
    const src = args?.source;
    if (!src || typeof src !== 'string') return { error: 'missing "source"' };
    const maxChars = Math.max(200, Math.min(Number(args?.max_chars) || 8000, 40000));

    const chunks = await rag.getBySource(ctx.userId, ctx.collection, src);
    if (chunks.length === 0) return { error: `no chunks with source="${src}"` };

    const joined = joinSourceChunks(chunks, src);

    // Surrogate-safe slice: pulling the cut back by one when the
    // last kept code unit is a high surrogate avoids handing the LLM
    // a string with a dangling lead surrogate (which JSON-serialisers
    // replace with U+FFFD and which can corrupt diff tools).
    let cut = maxChars;
    if (joined.length > cut) {
      const code = joined.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    return {
      source: src,
      chunks: chunks.length,
      text: joined.length > cut ? joined.slice(0, cut) : joined,
      truncated: joined.length > cut,
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
    let sources = await rag.listSources(ctx.userId, ctx.collection);
    let needle = typeof args?.contains === 'string' ? args.contains.trim().toLowerCase() : '';
    // Guard against pathological needle sizes. A reasonable filter is
    // a fragment of a path (under 200 chars); anything bigger is almost
    // certainly the agent confusing list_files with read_file.
    if (needle.length > 200) needle = needle.slice(0, 200);
    if (needle) sources = sources.filter(s => String(s.source).toLowerCase().includes(needle));
    const HARD_CAP = 100;
    const truncated = sources.length > HARD_CAP;
    return {
      count: sources.length,
      truncated,
      files: sources.slice(0, HARD_CAP), // hard cap so observations stay manageable
      ...(truncated ? { hint: `Showing first ${HARD_CAP} of ${sources.length}; refine with "contains".` } : {}),
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
    // Previously we retrieved with `useHybrid: true` — which ALREADY runs
    // BM25 internally — and then rebuilt a second BM25 index on the result.
    // Double work. Use cosine-only to get a broad semantic pool, then BM25
    // once over it for the final keyword-sensitive ranking that matters
    // for identifiers.
    const broad = await rag.retrieve(ctx.userId, ctx.collection, args.query, 30);
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
  schema: {
    query: 'string (required)',
    k: 'number (optional, default 5)',
    max_iters: 'number (optional, default 3, max 4)',
    beam_size: 'number (optional, default 4, max 8)',
    path_length: 'number (optional, default 3, max 5)',
  },
  async handler(args, ctx) {
    ensureCollection(ctx);
    if (!args?.query) return { error: 'missing "query"' };
    const k = Math.max(1, Math.min(Number(args.k) || 5, 15));
    const maxIters = Math.max(1, Math.min(Number(args.max_iters) || 3, 4));
    const beamSize = Math.max(2, Math.min(Number(args.beam_size) || 4, 8));
    const pathLength = Math.max(2, Math.min(Number(args.path_length) || 3, 5));

    // Full GEAR (§5): use the agent loop when an LLM client is available.
    // This lets the tool chain facts across hops instead of stopping at
    // the cheaper single-step graph expansion.
    if (ctx.openai && maxIters > 1) {
      try {
        const result = await gearAgent.agentLoop({
          userId: ctx.userId,
          collection: ctx.collection,
          query: args.query,
          openai: ctx.openai,
          k,
          maxIters,
          sessionId: ctx.sessionId || ctx.chatId || null,
          retrieveOpts: {
            useHybrid: true,
            useExpansion: true,
            useMMR: true,
            graphBeamSize: beamSize,
            graphLength: pathLength,
          },
        });

        return {
          mode: 'gear_agent',
          answer: result.answer || null,
          iterations: result.iterations,
          history: result.history,
          gist: result.gist.slice(0, 20),
          hits: result.passages.map(h => ({
            source: h.source,
            title: h.title,
            score: h.score,
            snippet: (h.text || '').slice(0, 400),
          })),
        };
      } catch (err) {
        console.warn('[agent-tools] search_graph GEAR loop failed; falling back to SyncGE:', err.message);
      }
    }

    // Single-hop SyncGE fallback: cheaper, deterministic, and still uses
    // graph expansion when the full agent loop is unavailable.
    const hits = await rag.retrieve(ctx.userId, ctx.collection, args.query, k, {
      useHybrid: true, useGraph: true, graphOpenAI: ctx.openai || null,
    });
    return {
      mode: 'syncge',
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

    const chunks = await rag.getBySource(ctx.userId, ctx.collection, source);
    if (chunks.length === 0) return { error: `no content for source="${source}"` };

    // Fast path: when the file was ingested via ingestCode, each chunk's
    // meta carries the exact symbol name. No re-chunking, correct line
    // numbers — the essential fix over the previous implementation that
    // re-ran code-chunker on concatenated text (which silently reset
    // line counts per chunk boundary).
    let fromMeta = chunks.filter(c => c.meta?.name === symbol);
    let matchKind = 'exact';
    if (fromMeta.length === 0) {
      // Case-insensitive fallback: agents sometimes mis-case symbol
      // names (`getName` vs `GetName`). Try lowercase before paying
      // the cost of re-chunking the concatenated text.
      const lower = symbol.toLowerCase();
      fromMeta = chunks.filter(c => typeof c.meta?.name === 'string' && c.meta.name.toLowerCase() === lower);
      if (fromMeta.length > 0) matchKind = 'case_insensitive';
    }
    if (fromMeta.length > 0) {
      return {
        source, symbol,
        match: matchKind,
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
    let symChunks = reChunked.filter(c => c.name === symbol);
    let reparsedMatch = 'reparsed';
    if (symChunks.length === 0) {
      const lowerSym = symbol.toLowerCase();
      symChunks = reChunked.filter(c => typeof c.name === 'string' && c.name.toLowerCase() === lowerSym);
      if (symChunks.length > 0) reparsedMatch = 'reparsed_case_insensitive';
    }
    if (symChunks.length === 0) return { error: `symbol "${symbol}" not found in ${source}` };
    return {
      source, symbol,
      match: reparsedMatch,
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
// The mask correctly handles:
//   - // line comments (JS/TS/Java/Go/Rust/C/C++)
//   - # line comments (Python, shell-style)
//   - /* … */ block comments
//   - "…" and '…' string literals with \-escape support
//   - Python triple-quoted strings (""" … """ and ''' … ''') across lines
// It does NOT fully handle template literals (JS `…${…}` with multi-line
// content); acceptable because the false-positive rate is low in practice
// and a full parse would require pulling in a tokeniser.

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
  const isPython = language === 'python';

  let inBlockComment = false;
  let inString = false;
  let stringChar = null;          // for single-char strings: '"', "'", "`"
  let inTripleString = false;     // for Python """ / '''
  let tripleChar = null;
  let escaped = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let hasCode = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      const after = line[i + 2];

      // Python triple-quoted strings take priority over everything —
      // they can contain `#`, `"`, `'`, braces, and newlines.
      if (inTripleString) {
        if (ch === tripleChar && next === tripleChar && after === tripleChar) {
          inTripleString = false; tripleChar = null; i += 2;
        }
        continue;
      }
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
      // Python triple-quote START?
      if (isPython && (ch === '"' || ch === "'") && next === ch && after === ch) {
        inTripleString = true; tripleChar = ch; i += 2;
        continue;
      }
      // Line comment?
      if (ch === '/' && next === '/' && language !== 'python' && language !== 'shell') break;
      if (isHashComment && ch === '#') break;
      // Block comment?
      if (ch === '/' && next === '*' && language !== 'python' && language !== 'shell') {
        inBlockComment = true; i++; continue;
      }
      // Single-quoted string start?
      if (ch === '"' || ch === "'" || (ch === '`' && (language === 'javascript' || language === 'typescript'))) {
        inString = true; stringChar = ch; continue;
      }
      if (!/\s/.test(ch)) hasCode = true;
    }
    codeMask[li] = hasCode;
  }
  return { lines, codeMask };
}

// Module-scope language → [regex, label] map so we don't re-build the
// pattern list on every console_log scan invocation.
const CONSOLE_LOG_PATTERNS = {
  javascript: [
    [/\bconsole\.(log|debug)\s*\(/, 'console.log'],
    // Match `debugger;` anywhere on a code-position line, not just
    // when it's alone — devs often stack it after another statement.
    [/\bdebugger\b\s*;?/, 'debugger'],
  ],
  python: [
    [/^\s*print\s*\(/, 'print()'],
    [/\bbreakpoint\s*\(/, 'breakpoint()'],
    [/\bpdb\s*\.\s*set_trace\s*\(/, 'pdb.set_trace()'],
  ],
};
CONSOLE_LOG_PATTERNS.typescript = CONSOLE_LOG_PATTERNS.javascript;
CONSOLE_LOG_PATTERNS.unknown = CONSOLE_LOG_PATTERNS.javascript;

// Module-scope so the array isn't re-allocated on every scan call.
// Patterns are tuned to common real-world secret formats; the matcher
// uses `.test()` and resets `lastIndex` between lines so the `g` flag
// stays harmless.
const HARDCODED_SECRET_PATTERNS = [
  { re: /(?:api[_-]?key|secret|passwd|password|token|bearer)\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{16,})["']/gi, msg: 'possible hard-coded credential' },
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, msg: 'AWS access key id' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, msg: 'OpenAI-style secret key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, msg: 'Slack token' },
  { re: /\bghp_[A-Za-z0-9]{36}\b/g, msg: 'GitHub personal access token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, msg: 'GitHub fine-grained token' },
  { re: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g, msg: 'Stripe API key' },
  { re: /\bAIza[A-Za-z0-9_\-]{35}\b/g, msg: 'Google API key' },
  { re: /\bsq0(?:atp|csp)-[A-Za-z0-9_\-]{22,}\b/g, msg: 'Square access token' },
  { re: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/g, msg: 'embedded private key block' },
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, msg: 'JWT-shaped token' },
];

const STATIC_CHECKS = [
  {
    // Renamed from 'long_function' — the check is applied to whole files,
    // not function bodies. The old id is kept as an alias below so existing
    // callers / tests don't break.
    id: 'long_source',
    description: 'Source files longer than 80 lines are hard to review',
    scan: (text, { lines }) => {
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
    description: 'Use of eval() / Function() / setTimeout-with-string — dynamic code execution',
    scan: (text, { lines, codeMask }) => {
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return; // skip pure-comment lines
        // Strip string literals so `"eval(x)"` inside a string doesn't
        // trigger; only real code-position matches should fire.
        const stripped = stripStringLiterals(line);
        if (/\beval\s*\(/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'eval() — dynamic code execution, audit carefully' });
          return;
        }
        if (/\b(?:new\s+)?Function\s*\(/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'Function() constructor — equivalent to eval(), audit carefully' });
          return;
        }
        // setTimeout/setInterval with a string first arg: detect by
        // looking at the ORIGINAL line. The first arg is a string literal
        // when the call site begins with `setTimeout("` or `setTimeout('`
        // (allowing whitespace).
        if (/\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'setTimeout/setInterval called with a string — implicit eval(), pass a function instead' });
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
      // Patterns live at module scope (HARDCODED_SECRET_PATTERNS) so
      // we don't reallocate them on every scan call.
      const out = [];
      const patterns = HARDCODED_SECRET_PATTERNS;
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
      const patterns = CONSOLE_LOG_PATTERNS[language] || [];
      if (patterns.length === 0) return out;

      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // Strip string literals so a quoted "debugger;" or "print(" in
        // code position doesn't trigger; only real call sites should fire.
        const stripped = stripStringLiterals(line);
        for (const [re, label] of patterns) {
          if (re.test(stripped)) {
            out.push({ severity: 'info', line: i + 1, message: `${label} left in code` });
            break;
          }
        }
      });
      return out;
    },
  },
  {
    id: 'weak_crypto',
    description: 'Use of broken hash algorithms (MD5, SHA-1) for security purposes',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // For createHash/hashlib the algorithm name lives INSIDE the
        // string literal, so we must match the raw line; stripStringLiterals
        // would erase the very token we're trying to detect. We still
        // strip strings for the `new MD5()` form to avoid flagging
        // doc-strings or example text.
        if (
          /createHash\s*\(\s*["'](md5|sha-?1)["']\s*\)/i.test(line) ||
          /hashlib\s*\.\s*(md5|sha1)\s*\(/i.test(line) ||
          /\bnew\s+(MD5|SHA1)\b/.test(stripStringLiterals(line))
        ) {
          out.push({ severity: 'warn', line: i + 1, message: 'broken hash (MD5/SHA-1) — use SHA-256 or stronger for security purposes' });
        }
      });
      return out;
    },
  },
  {
    id: 'subprocess_shell_true',
    description: 'Python subprocess.run/Popen with shell=True is vulnerable to shell injection',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // Match subprocess.run(... shell=True) / subprocess.Popen(... shell=True)
        // where shell=True appears anywhere on the same line.
        if (/\bsubprocess\s*\.\s*(run|Popen|call|check_call|check_output)\b/.test(line) && /\bshell\s*=\s*True\b/.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'subprocess shell=True is vulnerable to injection — pass argv list and shell=False (or omit shell)' });
        }
      });
      return out;
    },
  },
  {
    id: 'unsafe_pickle',
    description: 'Python pickle.load / pickle.loads can execute arbitrary code on untrusted input',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        if (/\bpickle\s*\.\s*loads?\s*\(/.test(line) || /\bcPickle\s*\.\s*loads?\s*\(/.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'pickle deserialisation is unsafe on untrusted input — use json or a typed format' });
        }
      });
      return out;
    },
  },
  {
    id: 'unsafe_yaml_load',
    description: 'PyYAML yaml.load without an explicit Loader allows arbitrary object construction',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // yaml.load(...) without `Loader=` argument is unsafe. yaml.safe_load
        // is fine. Match the function call and inspect what's inside the
        // parens on the SAME line — multi-line calls slip through, but
        // they're rare in practice and a static linter is a hint, not a
        // guarantee.
        const m = line.match(/\byaml\s*\.\s*load\s*\(([^)]*)\)/);
        if (!m) return;
        if (!/Loader\s*=/.test(m[1])) {
          out.push({ severity: 'high', line: i + 1, message: 'yaml.load without Loader= is unsafe — use yaml.safe_load or pass Loader=yaml.SafeLoader' });
        }
      });
      return out;
    },
  },
  {
    id: 'insecure_random_secret',
    description: 'Math.random() used for tokens, secrets, ids, or keys — not cryptographically secure',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        if (!/Math\.random\s*\(/.test(stripped)) return;
        // Same-line context heuristic: if the call sits next to a
        // sensitive identifier, it's almost certainly being used as a
        // secret source — Math.random is not cryptographically secure.
        if (/\b(token|secret|password|passwd|api[_-]?key|nonce|salt|csrf|session[_-]?id|reset[_-]?code|verification)\b/i.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'Math.random() is not secure — use crypto.randomBytes / crypto.randomUUID' });
        }
      });
      return out;
    },
  },
  {
    id: 'unsafe_innerhtml',
    description: 'Direct innerHTML / outerHTML / document.write writes — common XSS vector',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        if (/\.(innerHTML|outerHTML)\s*[+]?=/.test(stripped) ||
            /\bdocument\.write(?:ln)?\s*\(/.test(stripped) ||
            /\bdangerouslySetInnerHTML\b/.test(stripped)) {
          out.push({ severity: 'warn', line: i + 1, message: 'unsafe HTML sink — sanitize input or use textContent' });
        }
      });
      return out;
    },
  },
  {
    id: 'empty_catch',
    description: 'Empty catch / except block — errors are silently swallowed',
    scan: (text, { codeMask, lines, language }) => {
      const out = [];
      if (language === 'javascript' || language === 'typescript' || language === 'java') {
        const re = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const upto = text.slice(0, m.index);
          const line = upto.split('\n').length;
          if (!codeMask[line - 1]) continue;
          out.push({ severity: 'warn', line, message: 'empty catch block — handle or rethrow' });
        }
      } else if (language === 'python') {
        // Python `except: pass` and `except SomeError: pass`. We
        // approximate by matching a line ending in a `:` after `except`
        // and the next non-empty line being just `pass`.
        for (let i = 0; i < lines.length; i++) {
          if (!codeMask[i]) continue;
          if (!/^\s*except\b[^:]*:\s*(?:#.*)?$/.test(lines[i])) continue;
          // Find next non-empty line
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && /^\s*pass\s*(?:#.*)?$/.test(lines[j])) {
            out.push({ severity: 'warn', line: i + 1, message: 'empty except block — log or rethrow the error' });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'os_system_call',
    description: 'Python os.system / os.popen — shell-execution sink, prefer subprocess with argv list',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        if (/\bos\s*\.\s*(system|popen)\s*\(/.test(line)) {
          out.push({ severity: 'warn', line: i + 1, message: 'os.system / os.popen — prefer subprocess.run with argv list (no shell=True)' });
        }
      });
      return out;
    },
  },
  {
    id: 'dynamic_require',
    description: 'Node require() called with a non-literal argument — risk of arbitrary module loading',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // Match require( ... ) where the inner argument is not a quoted
        // literal. Conservative: we only flag when we can clearly see
        // a non-string identifier or template/expression inside.
        const m = line.match(/\brequire\s*\(\s*([^)]*)\)/);
        if (!m) return;
        const arg = m[1].trim();
        if (!arg) return;
        // Pure literal? skip.
        if (/^["'][^"']*["']$/.test(arg)) return;
        // Template literal with no interpolation?
        if (/^`[^`$]*`$/.test(arg)) return;
        out.push({ severity: 'warn', line: i + 1, message: 'dynamic require() — load a static module path or whitelist' });
      });
      return out;
    },
  },
  {
    id: 'sql_injection_concat',
    description: 'SQL string built via concatenation / template interpolation — use parameterised queries',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // Look for SQL verbs adjacent to concatenation/interpolation. We
        // intentionally keep this conservative — the goal is to flag the
        // obvious `"SELECT ... " + userInput` shape, not every templated
        // query. Parameterised drivers (`$1`, `?`) won't match because
        // the placeholder sits inside the string literal, not after a `+`.
        const sqlVerb = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|UNION\s+SELECT)\b/i;
        if (!sqlVerb.test(line)) return;
        // JS/TS: template literal with `${...}` interpolation containing a SQL verb.
        if (/`[^`]*\$\{[^}]+\}[^`]*\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b/i.test(line) ||
            /`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b[^`]*\$\{[^}]+\}/i.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'SQL built with template-literal interpolation — use parameterised queries' });
          return;
        }
        // JS/TS/Python: classic `"...SELECT..." + var` or `f"...{var}..."` shape.
        if (/["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b[^"']*["']\s*\+/i.test(line) ||
            /\+\s*["'][^"']*\b(WHERE|FROM|VALUES|SET)\b/i.test(line) ||
            /\bf["'][^"']*\{[^}]+\}[^"']*\b(SELECT|WHERE|FROM)\b/i.test(line) ||
            /\bf["'][^"']*\b(SELECT|WHERE|FROM)\b[^"']*\{[^}]+\}/i.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'SQL built via string concatenation/f-string — use parameterised queries' });
        }
      });
      return out;
    },
  },
  {
    id: 'path_traversal',
    description: 'Filesystem path joined with unchecked user input — possible traversal (..)',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        // Pattern A: explicit "../" segment in a path string passed to fs/open.
        if (/(?:fs\.|require\(|open\(|readFile|writeFile|createReadStream|createWriteStream)/.test(stripped) &&
            /\.\.\//.test(line)) {
          out.push({ severity: 'warn', line: i + 1, message: 'literal "../" in filesystem path — possible traversal' });
          return;
        }
        // Pattern B: path.join / os.path.join concatenated with a parameter
        // named req|input|user|param — common shape of unchecked input.
        if (/\b(?:path\.join|os\.path\.join|path\.resolve)\s*\([^)]*\b(req|request|input|user|params|body|query)\b[^)]*\)/.test(stripped)) {
          out.push({ severity: 'warn', line: i + 1, message: 'path joined with request/user input — validate or normalise to prevent traversal' });
        }
      });
      return out;
    },
  },
  {
    id: 'cors_wildcard',
    description: 'CORS Access-Control-Allow-Origin set to "*" — disables origin protection',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // Express/Node: cors({ origin: '*' }) or res.header('Access-Control-Allow-Origin', '*')
        if (/\borigin\s*:\s*['"`]\*['"`]/.test(line) ||
            /access-control-allow-origin['"`]?\s*[,)]\s*['"`]\*/i.test(line) ||
            /set_header\s*\(\s*['"]access-control-allow-origin['"]\s*,\s*['"]\*/i.test(line)) {
          out.push({ severity: 'warn', line: i + 1, message: 'CORS wildcard "*" — restrict to known origins for credentialed endpoints' });
        }
      });
      return out;
    },
  },
  {
    id: 'prototype_pollution',
    description: 'Direct write to Object.prototype / __proto__ — prototype pollution vector',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        // Object.assign(Object.prototype, ...) / Object.assign(Foo.prototype, userInput)
        if (/Object\.assign\s*\(\s*(?:Object|[A-Za-z_$][\w$]*)\s*\.\s*prototype\b/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'Object.assign() into a prototype — prototype pollution risk' });
          return;
        }
        // Direct assignment: foo.__proto__ = bar  /  foo['__proto__'] = bar
        if (/\b__proto__\s*=/.test(stripped) || /\[\s*['"]__proto__['"]\s*\]\s*=/.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: '__proto__ assignment — prototype pollution risk, use Object.create(null) or a Map' });
          return;
        }
        // Object.setPrototypeOf with non-null target
        if (/Object\.setPrototypeOf\s*\(/.test(stripped)) {
          out.push({ severity: 'warn', line: i + 1, message: 'Object.setPrototypeOf — review for prototype pollution and perf' });
        }
      });
      return out;
    },
  },
  {
    id: 'open_redirect',
    description: 'res.redirect / location.href fed directly from request input — open-redirect vector',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        // res.redirect(req.query.next) / res.redirect(req.body.url) / res.location(req.params.x)
        if (/\bres\s*\.\s*(redirect|location)\s*\(\s*(?:[^)]*\b)?req\s*\.\s*(query|body|params|headers)\b/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'res.redirect/location with raw request input — validate against an allow-list to prevent open-redirect' });
          return;
        }
        // window.location = req.query.X / location.href = userInput pattern
        if (/\b(?:window\.)?location(?:\.href)?\s*=\s*[^;]*\breq\s*\.\s*(query|body|params)\b/.test(stripped)) {
          out.push({ severity: 'high', line: i + 1, message: 'location assignment from request input — open-redirect risk' });
        }
      });
      return out;
    },
  },
  {
    id: 'unsafe_jwt',
    description: 'JWT verification with algorithm "none" or unspecified algorithms — accepts forged tokens',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        // alg: 'none' / algorithm: 'none' / "alg": "none"
        if (/\b(?:alg|algorithm|algorithms?)\s*[:=]\s*\[?\s*['"]none['"]/i.test(line)) {
          out.push({ severity: 'high', line: i + 1, message: 'JWT alg "none" — accepts unsigned tokens, never use in production' });
          return;
        }
        // jwt.decode(token) when result is used as if verified — flag as warn
        const stripped = stripStringLiterals(line);
        if (/\bjwt\s*\.\s*decode\s*\(/.test(stripped) && !/verify/i.test(stripped)) {
          out.push({ severity: 'warn', line: i + 1, message: 'jwt.decode does NOT verify the signature — use jwt.verify with explicit algorithms' });
        }
      });
      return out;
    },
  },
  {
    id: 'timing_unsafe_compare',
    description: 'Token / hash comparison via == / === — leaks length info via timing side-channel',
    scan: (text, { lines, codeMask, language }) => {
      if (language !== 'javascript' && language !== 'typescript' && language !== 'python' && language !== 'unknown') return [];
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        // === / == comparison adjacent to a sensitive identifier on either side
        const sensitiveCmp = /\b(token|secret|signature|hmac|hash|digest|api[_-]?key|password|csrf|otp|reset[_-]?code)\w*\s*={2,3}\s*\w/i;
        const sensitiveCmp2 = /\w\s*={2,3}\s*\w*\b(token|secret|signature|hmac|hash|digest|api[_-]?key|password|csrf|otp|reset[_-]?code)/i;
        if (sensitiveCmp.test(stripped) || sensitiveCmp2.test(stripped)) {
          out.push({ severity: 'warn', line: i + 1, message: 'timing-unsafe comparison on secret — use crypto.timingSafeEqual / hmac.compare_digest' });
        }
      });
      return out;
    },
  },
  {
    id: 'disabled_ssl_verification',
    description: 'TLS verification disabled — exposes the call to MITM',
    scan: (text, { lines, codeMask, language }) => {
      const out = [];
      lines.forEach((line, i) => {
        if (!codeMask[i]) return;
        const stripped = stripStringLiterals(line);
        if (language === 'javascript' || language === 'typescript' || language === 'unknown') {
          if (/\brejectUnauthorized\s*:\s*false\b/.test(stripped) ||
              /\bNODE_TLS_REJECT_UNAUTHORIZED\b\s*=\s*['"]?0['"]?/.test(stripped)) {
            out.push({ severity: 'high', line: i + 1, message: 'TLS verification disabled (rejectUnauthorized:false / NODE_TLS_REJECT_UNAUTHORIZED=0)' });
            return;
          }
        }
        if (language === 'python' || language === 'unknown') {
          if (/\bverify\s*=\s*False\b/.test(stripped) ||
              /\bssl\._create_unverified_context\s*\(/.test(stripped) ||
              /\bcheck_hostname\s*=\s*False\b/.test(stripped)) {
            out.push({ severity: 'high', line: i + 1, message: 'TLS verification disabled (verify=False / unverified_context)' });
          }
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

    // Hard cap on inspected content. Without this a caller could pass
    // a 10 MB string and the checks (regex scans, comment-mask builder)
    // would happily allocate hundreds of megabytes of intermediate state.
    const STATIC_CHECK_MAX_CHARS = 200000;
    let content = args?.content;
    let inputTruncated = false;
    if (!content) {
      // Reconstruct the FULL source directly — NOT via read_file, whose public
      // max_chars is hard-capped at 40_000. Routing the scan through read_file
      // silently truncated every file to 40k, so any vulnerability past the
      // first 40k chars (weak crypto, unsafe_html, TLS-disabled, …) escaped
      // detection on large files. We re-join the chunks and apply the scan's
      // own 200k ceiling instead.
      const chunks = await rag.getBySource(ctx.userId, ctx.collection, src);
      if (!chunks || chunks.length === 0) return { error: `no chunks with source="${src}"` };
      content = joinSourceChunks(chunks, src);
      if (content.length > STATIC_CHECK_MAX_CHARS) {
        content = content.slice(0, STATIC_CHECK_MAX_CHARS);
        inputTruncated = true;
      }
    } else if (typeof content !== 'string') {
      return { error: '"content" must be a string when provided' };
    } else if (content.length > STATIC_CHECK_MAX_CHARS) {
      content = content.slice(0, STATIC_CHECK_MAX_CHARS);
      inputTruncated = true;
    }

    const language = codeChunker.detectLanguage(src, content);
    // Build the comment/string mask ONCE and pass it to every check so
    // each regex scan runs in O(lines) rather than re-tokenising.
    const { lines, codeMask } = buildCommentCodeMask(content, language);
    const findings = [];
    const checkErrors = [];
    for (const check of STATIC_CHECKS) {
      // Run each check in isolation: a regex backtracking blow-up or
      // an unexpected runtime error in one check shouldn't drop the
      // findings from every other check. Failures are surfaced as
      // checkErrors so the agent can flag the bad rule.
      try {
        const hits = check.scan(content, { language, lines, codeMask });
        for (const h of hits) findings.push({ rule: check.id, ...h });
      } catch (err) {
        checkErrors.push({ rule: check.id, error: err?.message || String(err) });
      }
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
      ...(inputTruncated ? { inputTruncated: true, scannedChars: content.length } : {}),
      ...(checkErrors.length ? { checkErrors } : {}),
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
    // Hard cap on the replacement payload. Without this an agent could
    // emit a multi-MB blob that bloats every transcript and downstream
    // serialiser; 200 KB matches the static_checks input ceiling.
    const REPLACEMENT_MAX = 200000;
    if (replacement.length > REPLACEMENT_MAX) {
      return { error: `replacement exceeds ${REPLACEMENT_MAX} chars (got ${replacement.length}); split the patch into smaller proposals` };
    }
    const startNum = Number(start_line);
    const endNum = Number(end_line);
    const startOk = Number.isFinite(startNum) && startNum > 0;
    const endOk = Number.isFinite(endNum) && endNum > 0;
    // If both lines are provided they must form a valid range. Inverted
    // ranges silently produced no-op patches in the caller before; surface
    // the error so the agent regenerates the proposal.
    if (startOk && endOk && startNum > endNum) {
      return { error: `invalid range: start_line (${startNum}) > end_line (${endNum})` };
    }
    return {
      proposed: true,
      source,
      start_line: startOk ? startNum : null,
      end_line: endOk ? endNum : null,
      replacement,
      rationale: rationale || '(no rationale provided)',
    };
  },
};

// ─── Web search (free providers, no API key) ────────────────────────────────

const web_search = {
  name: 'web_search',
  description: 'Search the open web. Uses Brave Search when BRAVE_SEARCH_API_KEY is set (freshest, highest quality) and otherwise free, key-less providers (DuckDuckGo → Wikipedia → SearXNG). Use when the answer needs information past the model cutoff or specific recent facts. Pass freshness ("pd"=day, "pw"=week, "pm"=month, "py"=year) for recent/news queries. Returns up to maxResults normalised hits.',
  schema: {
    query: 'string (required — the search query)',
    maxResults: 'number (optional, default 5, max 15)',
    locale: 'string (optional — BCP47-ish like "es-es" or "en"; nudges provider region/language)',
    freshness: 'string (optional — recency window: pd|pw|pm|py or day|week|month|year; honoured by Brave)',
  },
  async handler(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'missing "query"' };
    const maxResults = Math.max(1, Math.min(Number(args?.maxResults) || 5, 15));
    const locale = typeof args?.locale === 'string' ? args.locale : null;
    const freshness = typeof args?.freshness === 'string' ? args.freshness : undefined;
    // Use the aggregating/relevance-ranked path for chat. The legacy
    // first-non-empty search() path can be fooled by a broad academic provider
    // returning unrelated papers before the general-web providers answer.
    const { results, provider, providers, cached, attempts } = await webSearch.searchMany(query, { maxResults, locale, freshness });
    // Return structured JSON (not a concatenated string) so the model can
    // cite individual URLs rather than treat the whole response as prose.
    return {
      provider,
      providers,
      cached,
      count: results.length,
      results,
      // Slim attempt trace — useful when the model needs to explain why
      // a query returned nothing ("DDG timed out, Wikipedia 0 hits").
      attempts: Array.isArray(attempts)
        ? attempts.map(({ id, ok, ms, count }) => ({ id, ok, ms, count }))
        : [],
    };
  },
};

// ─── Read URL (free, key-less) ──────────────────────────────────────────────
//
// Companion to web_search: once the agent picks a URL from search results,
// it usually needs the full page text (snippets are often 1-2 sentences).
// read_url runs the @mozilla/readability extractor inside jsdom and returns
// clean markdown. Implementation lives under backend/src/skills/read_url so
// the same logic is reachable from the skills-registry path; this entry is
// the legacy ALL_TOOLS-array adapter so react-agent / agent-core can pick
// it up via the same pick() helper as everything else.

const readUrlSkill = require('../../skills/read_url/handler');

const read_url = {
  name: 'read_url',
  description: 'Fetch a single public URL and return its main readable content as markdown (Firefox Reader-style). Use AFTER web_search when a snippet is not enough. Hard 8 s timeout, 1 MB HTML cap, 50 000 char markdown cap. Respects robots.txt and never follows cross-domain redirects.',
  schema: {
    url: 'string (required — absolute http(s) URL)',
    maxChars: 'number (optional, default 12000, max 50000)',
  },
  async handler(args) {
    return readUrlSkill.execute(args || {});
  },
};

const web_extract = {
  name: 'web_extract',
  description: 'Extract readable markdown from a public web page. Alias of read_url for web scraping workflows; use after web_search when snippets are insufficient. Applies the same SSRF, robots.txt, redirect, timeout and content-size protections.',
  schema: {
    url: 'string (required — absolute http(s) URL)',
    maxChars: 'number (optional, default 12000, max 50000)',
  },
  async handler(args, ctx) {
    return read_url.handler(args, ctx);
  },
};

const session_search = {
  name: 'session_search',
  description: 'Search past chat conversations owned by the current user. Use when the user asks to find, recall, resume, or quote something from previous sessions. Returns matching message snippets with session ids and titles.',
  schema: {
    query: 'string (required — terms to search in past messages)',
    limit: 'number (optional, default 8, max 25)',
    sessionId: 'string (optional — restrict search to one chat session)',
    includeArchived: 'boolean (optional, default false)',
  },
  async handler(args, ctx) {
    // eslint-disable-next-line global-require
    const { searchSessions } = require('../session-search');
    return searchSessions(args || {}, ctx || {});
  },
};

const session_list = {
  name: 'session_list',
  description: 'List the current user\u2019s recent chat sessions (id, title, model, message count, last-updated). Use when the user asks "what was I working on", "show my recent chats", or to find a prior thread to resume before answering.',
  schema: {
    limit: 'number (optional, default 10, max 50 — most-recently-updated first)',
    includeArchived: 'boolean (optional, default false)',
  },
  async handler(args, ctx) {
    // eslint-disable-next-line global-require
    const { listSessions } = require('../session-recall');
    return listSessions(args || {}, ctx || {});
  },
};

const session_history = {
  name: 'session_history',
  description: 'Read the most recent messages from one of the user\u2019s own past chat sessions, in chronological order. Use after session_list/session_search to open a prior thread and recall exactly what was discussed before continuing the work. Only returns sessions owned by the current user.',
  schema: {
    sessionId: 'string (required — chat/session id, e.g. from session_list or session_search)',
    limit: 'number (optional, default 20, max 50 — most recent messages)',
  },
  async handler(args, ctx) {
    // eslint-disable-next-line global-require
    const { fetchSessionHistory } = require('../session-recall');
    return fetchSessionHistory(args || {}, ctx || {});
  },
};

// ─── Sub-agents (OpenClaw sessions_send / spawn — cost-guarded) ─────────────

const session_send = {
  name: 'session_send',
  description: 'Append a message to one of the user\u2019s own existing chat sessions. By default leaves an assistant NOTE (cheap, no agent run) — use this to record a result/follow-up in another session. Set runAgent:true to run a sub-agent on the message (sandboxed, depth- and budget-limited; may cost credits).',
  schema: {
    sessionId: 'string (required — target chat id, must belong to the user)',
    message: 'string (required — content to append)',
    runAgent: 'boolean (optional, default false — if true, run a sandboxed sub-agent on the message)',
    thinking: 'string (optional — low|medium|high, only when runAgent:true)',
  },
  async handler(args, ctx) {
    const context = ctx || {};
    if (args && args.runAgent) {
      // eslint-disable-next-line global-require
      const { reserveSpawn } = require('./subagent-guard');
      const verdict = reserveSpawn(context);
      if (!verdict.allowed) {
        return { appended: false, ran: false, reason: verdict.reason };
      }
    }
    // eslint-disable-next-line global-require
    const { execute } = require('../../skills/session_send/handler');
    return execute(args || {}, context);
  },
};

const session_spawn = {
  name: 'session_spawn',
  description: 'Launch a sandboxed sub-agent in a NEW chat session with a focused, self-contained prompt. Use to parallelise a side-task ("research this in the background") without losing the main thread. Runs at depth+1 in sandbox mode, capped by a per-turn budget; returns the new session id and the sub-agent\u2019s answer. May cost credits.',
  schema: {
    prompt: 'string (required — self-contained task for the sub-agent; it does NOT see this chat\u2019s history)',
    title: 'string (optional — short title for the new session, <= 80 chars)',
    thinking: 'string (optional — low|medium|high, default low)',
  },
  async handler(args, ctx) {
    const context = ctx || {};
    // eslint-disable-next-line global-require
    const { reserveSpawn } = require('./subagent-guard');
    const verdict = reserveSpawn(context);
    if (!verdict.allowed) {
      return { spawned: false, reason: verdict.reason };
    }
    // eslint-disable-next-line global-require
    const { execute } = require('../../skills/session_spawn/handler');
    return execute(args || {}, context);
  },
};

// ─── Browser automation (driver injected by caller) ────────────────────────

const browser_navigate = {
  name: 'browser_navigate',
  description: 'Navigate the active browser session to an absolute http(s) URL. Requires ctx.browserAgent, ctx.browserDriver, ctx.browserAdapter, or ctx.browser to be injected by the caller.',
  schema: {
    url: 'string (required — absolute http(s) URL)',
  },
  async handler(args, ctx) {
    return runBrowserAction('navigate', { url: args?.url }, ctx || {});
  },
};

const browser_click = {
  name: 'browser_click',
  description: 'Click an element in the active browser session using a CSS selector.',
  schema: {
    selector: 'string (required — CSS selector to click)',
  },
  async handler(args, ctx) {
    return runBrowserAction('click', { selector: args?.selector }, ctx || {});
  },
};

const browser_type = {
  name: 'browser_type',
  description: 'Type text into an element in the active browser session using a CSS selector. The returned evidence redacts the typed text and reports only its length.',
  schema: {
    selector: 'string (required — CSS selector for the target input/textarea)',
    text: 'string (required — text to type)',
  },
  async handler(args, ctx) {
    return runBrowserAction('type', { selector: args?.selector, text: args?.text }, ctx || {});
  },
};

const browser_scroll = {
  name: 'browser_scroll',
  description: 'Scroll the active browser session. Provide y for pixel delta, selector to scroll to an element, or neither to scroll down one viewport.',
  schema: {
    y: 'number (optional — vertical pixel delta; default 800 when selector is omitted)',
    selector: 'string (optional — CSS selector to scroll into view)',
  },
  async handler(args, ctx) {
    const payload = {};
    const selector = typeof args?.selector === 'string' && args.selector.trim() ? args.selector.trim() : '';
    if (selector) payload.selector = selector;
    const y = Number(args?.y);
    if (Number.isFinite(y)) payload.y = y;
    if (!selector && !Number.isFinite(y)) payload.y = 800;
    return runBrowserAction('scroll', payload, ctx || {});
  },
};

// ─── GitHub search (repos / code / issues / users / topics) ─────────────────
//
// Mines open-source projects worldwide for libraries, prior art and reference
// implementations. Repositories / issues / users / topics work with no API key
// (GitHub's 10 req/min anonymous search budget); code search needs a token
// (SIRAGPT_GITHUB_TOKEN || GITHUB_TOKEN). Degrades gracefully without one.

const github_search = {
  name: 'github_search',
  description: 'Search GitHub for open-source repositories, code, issues/PRs, users/orgs or topics. Use to find libraries, reference implementations and prior art across projects worldwide. type defaults to "repositories" (ranked by stars). Code search needs a configured token. Returns up to limit normalised hits.',
  schema: {
    query: 'string (required — keywords, optionally with GitHub qualifiers)',
    type: 'string (optional — repositories|code|issues|users|topics; default repositories)',
    limit: 'number (optional, default 10, max 50)',
    language: 'string (optional — restrict by programming language, e.g. "typescript")',
    sort: 'string (optional — stars|forks|updated for repos; comments|reactions|updated for issues)',
    minStars: 'number (optional — minimum star count for repositories)',
    repo: 'string (optional — owner/name to scope code/issue search)',
  },
  async handler(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'missing "query"' };
    // eslint-disable-next-line global-require
    const githubSearch = require('../github-search');
    const opts = {
      type: args?.type,
      limit: Math.max(1, Math.min(Number(args?.limit) || 10, 50)),
      language: typeof args?.language === 'string' ? args.language : undefined,
      sort: typeof args?.sort === 'string' ? args.sort : undefined,
      minStars: Number.isFinite(Number(args?.minStars)) ? Number(args.minStars) : undefined,
      repo: typeof args?.repo === 'string' ? args.repo : undefined,
    };
    const { items, type, count, errors, authenticated } = await githubSearch.search(query, opts);
    return { type, count, authenticated, items, errors: Array.isArray(errors) ? errors : [] };
  },
};

// ─── Scientific paper search (arXiv / OpenAlex / CrossRef / PubMed / …) ──────
//
// Unified key-less search over the major open scientific-paper APIs plus
// worldwide regional indices (DOAJ open-access journals, DBLP computer science,
// DataCite datasets). Use for peer-reviewed sources, citations and lit reviews.

const scientific_search = {
  name: 'scientific_search',
  description: 'Search peer-reviewed scientific papers across APIs worldwide (arXiv, OpenAlex, CrossRef, PubMed, Europe PMC, Semantic Scholar, CORE, DOAJ, DBLP, DataCite, SciELO + Redalyc for Latin-American/Iberian sources, bioRxiv + medRxiv for life-science/medical preprints, plus Scopus and Web of Science when their API keys are configured). Results are interleaved across sources so the top reflects diverse providers, not just one. Use when the user needs academic sources, citations, DOIs or a literature review. Returns ranked papers with title, authors, year, venue, citations, abstract and PDF/HTML links.',
  schema: {
    query: 'string (required — research topic or keywords)',
    limit: 'number (optional per-provider cap, default 8, max 25)',
    providers: 'array (optional subset, e.g. ["biorxiv","medrxiv","scielo","redalyc","scopus","wos"]; default all)',
    unpaywall: 'boolean (optional — backfill open-access PDF links for DOI hits that lack one, e.g. Scopus/WoS/CrossRef; slightly slower)',
  },
  async handler(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'missing "query"' };
    // eslint-disable-next-line global-require
    const scientificSearch = require('../scientific-search');
    const limit = Math.max(1, Math.min(Number(args?.limit) || 8, 25));
    const providers = Array.isArray(args?.providers) ? args.providers : undefined;
    const unpaywall = args?.unpaywall === true || args?.unpaywall === 'true';
    const { papers, errors, providers: used } = await scientificSearch.search(query, { limit, providers, unpaywall });
    // Slim the payload: the model rarely needs every field and abstracts are long.
    const slim = (papers || []).slice(0, limit).map((p) => ({
      source: p.source,
      title: p.title,
      authors: (p.authors || []).slice(0, 6).map((a) => a.name).filter(Boolean),
      year: p.year,
      venue: p.venue,
      citations: p.citations,
      doi: p.doi,
      openAccess: p.openAccess,
      url: p.htmlUrl || p.pdfUrl || null,
      pdfUrl: p.pdfUrl || null,
      abstract: p.abstract ? String(p.abstract).slice(0, 600) : null,
    }));
    return { count: slim.length, providers: used, papers: slim, errors: Array.isArray(errors) ? errors : [] };
  },
};

// ─── X (Twitter) live search via xAI Live Search ────────────────────────────
//
// Real-time X/Twitter retrieval. Key-gated on XAI_API_KEY: with no key the
// tool returns `{ configured:false, note }` instead of failing, so the agent
// can tell the user it needs configuration rather than hallucinating posts.

const x_search = {
  name: 'x_search',
  description: 'Search X (Twitter) in real time for recent posts about a topic, person, event or $ticker. Use for breaking news, public sentiment or what people are saying right now on X. Requires XAI_API_KEY (xAI Live Search); when unconfigured it returns configured:false with a note — never invent posts. Returns a concise summary plus the source post URLs (citations).',
  schema: {
    query: 'string (required — what to look up on X/Twitter)',
    maxResults: 'number (optional, default 15, max 30)',
    handles: 'array (optional — restrict to specific X handles, without the @)',
    fromDate: 'string (optional — ISO date YYYY-MM-DD lower bound)',
    toDate: 'string (optional — ISO date YYYY-MM-DD upper bound)',
  },
  async handler(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'missing "query"' };
    // eslint-disable-next-line global-require
    const xSearch = require('../x-search');
    const out = await xSearch.search(query, {
      maxResults: Math.max(1, Math.min(Number(args?.maxResults) || 15, 30)),
      handles: Array.isArray(args?.handles) ? args.handles : undefined,
      fromDate: typeof args?.fromDate === 'string' ? args.fromDate : undefined,
      toDate: typeof args?.toDate === 'string' ? args.toDate : undefined,
    });
    return {
      configured: out.configured,
      query: out.query,
      model: out.model,
      summary: out.summary,
      count: Array.isArray(out.results) ? out.results.length : 0,
      results: out.results || [],
      note: out.note,
    };
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  read_file, list_files, search_docs, search_code, search_graph, get_symbol, static_checks, propose_patch,
  web_search, read_url, web_extract, session_search, session_list, session_history,
  session_send, session_spawn,
  browser_navigate, browser_click, browser_type, browser_scroll,
  github_search, scientific_search, x_search,
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
  web_search, read_url, web_extract, session_search, session_list, session_history,
  session_send, session_spawn,
  browser_navigate, browser_click, browser_type, browser_scroll,
  github_search, scientific_search, x_search,
  STATIC_CHECKS,
  buildCommentCodeMask, // exported for tests
  stripStringLiterals,  // exported for tests
  commentPrefixFor,     // exported for tests
  formatChunkSeparator, // exported for tests
};
