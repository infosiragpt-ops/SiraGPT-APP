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
const gearAgent = require('../gear-agent');

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureCollection(ctx) {
  if (!ctx?.userId || !ctx?.collection) {
    throw new Error('tool requires ctx.userId and ctx.collection');
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
    case 'r': case 'jl':
      return '#';
    case 'html': case 'htm': case 'xml': case 'svg':
      return '<!--';
    case 'css': case 'scss': case 'less':
      return '/*';
    case 'sql':
      return '--';
    case 'lisp': case 'clj': case 'scm':
      return ';;';
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

    const prefix = commentPrefixFor(src);
    const joined = chunks
      .map(c => {
        if (!c.title) return c.text;
        const sep = formatChunkSeparator(prefix, c.title);
        return sep ? `${sep}\n${c.text}` : c.text;
      })
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
    let sources = await rag.listSources(ctx.userId, ctx.collection);
    const needle = typeof args?.contains === 'string' ? args.contains.trim().toLowerCase() : '';
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
        // Match `debugger;` anywhere on a code-position line, not just
        // when it's alone — devs often stack it after another statement.
        patterns.push([/\bdebugger\b\s*;?/, 'debugger']);
      }
      if (language === 'python') {
        patterns.push([/^\s*print\s*\(/, 'print()']);
        patterns.push([/\bbreakpoint\s*\(/, 'breakpoint()']);
        patterns.push([/\bpdb\s*\.\s*set_trace\s*\(/, 'pdb.set_trace()']);
      }

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
  commentPrefixFor,     // exported for tests
  formatChunkSeparator, // exported for tests
};
