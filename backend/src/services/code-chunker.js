/**
 * code-chunker — AST-lite chunking for source code.
 *
 * Naive paragraph chunking (the generic chunk() in rag-service.js) is a
 * terrible fit for code: it cuts mid-function, mixes declarations with
 * bodies, and strands docstrings. Retrieval quality on code bases drops
 * accordingly — a query for "`createUser` signature" returns the
 * paragraph that happened to contain `createUser` instead of the whole
 * function.
 *
 * This chunker splits code on syntactic boundaries — functions, classes,
 * interfaces, top-level blocks — using language-specific regexes. It's
 * not a real parser; Tree-sitter would do better, but pulling in
 * native bindings in a Node backend that already ships to Vercel isn't
 * worth the deploy complexity for what's an 80/20 win over paragraphs.
 *
 * What you get per chunk:
 *   { text, startLine, endLine, language, nodeType, name, isExported, isAsync }
 *
 * Supported languages: TypeScript/TSX, JavaScript/JSX, Python, Java, Go,
 * Rust, C/C++. Unknown → sliding line window with configurable size.
 *
 * Pattern reference: Iliagpt.io server/rag/chunking/CodeChunker.ts.
 * Simplified by dropping the ChunkMetadata/PipelineChunk typing — we just
 * return plain objects and let the caller decide how to persist them.
 */

const DEFAULTS = {
  lineChunkSize: 60,      // lines per window for fallback chunker
  lineOverlap: 10,        // lines shared between adjacent fallback windows
  includeImports: true,   // prepend the import block to each chunk
  // Default 1 — keep named one-liners (`const f = x => x * 2;`) since the
  // symbol name itself is a retrieval target. Callers that truly want to
  // drop tiny helpers can pass a higher minLines. The previous default
  // of 3 silently dropped every single-line arrow/variable declaration.
  minLines: 1,
  maxChars: 3000,         // hard cap so a 10k-line class doesn't produce one mega-chunk
};

const EXT_TO_LANG = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  c: 'c', h: 'c',
};

function detectLanguage(filename, content) {
  if (typeof filename === 'string' && filename.includes('.')) {
    const ext = filename.split('.').pop().toLowerCase();
    if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  }
  // Heuristic fallback on content — useful when the filename is missing
  // or is something like "stdin" or "paste".
  if (!content) return 'unknown';
  if (/^\s*(import\s+\w|from\s+\w+\s+import|def\s+\w+\s*\()/m.test(content)) return 'python';
  if (/^\s*package\s+\w+\s*$/m.test(content) && /\bfunc\s+\w+\s*\(/.test(content)) return 'go';
  if (/^\s*(import\s+.+\s+from\s+|export\s+(default|const|function|class)\s|const\s+\w+\s*:\s*\w+\s*=)/m.test(content)) return 'typescript';
  if (/^\s*(import\s+.+\s+from\s+|function\s+\w+|const\s+\w+\s*=\s*\()/m.test(content)) return 'javascript';
  if (/^\s*(fn\s+\w+\s*\(|use\s+\w+(::\w+)+;)/m.test(content)) return 'rust';
  if (/^\s*(public\s+class\s+\w+|import\s+java\.)/m.test(content)) return 'java';
  if (/^\s*#include\s*[<"]/m.test(content)) return /\bclass\s+\w+/.test(content) ? 'cpp' : 'c';
  return 'unknown';
}

// ─── Import block extraction ────────────────────────────────────────────────

function extractImports(lines, language) {
  const importLines = [];
  let i = 0;

  const isImport = (line) => {
    const l = line.trim();
    if (l === '' || l.startsWith('//') || l.startsWith('#')) return 'maybe';
    switch (language) {
      case 'typescript':
      case 'javascript':
        return /^(import\s|export\s+(\*|\{)|const\s+\w+\s*=\s*require\()/.test(l) ? 'yes' : 'no';
      case 'python':
        return /^(import\s|from\s+\S+\s+import)/.test(l) ? 'yes' : 'no';
      case 'java':
        return /^(package\s|import\s)/.test(l) ? 'yes' : 'no';
      case 'go':
        return /^(package\s|import\s)/.test(l) || (importLines.length > 0 && /^[\s"]|^\)$/.test(l)) ? 'yes' : 'no';
      case 'rust':
        return /^(use\s|mod\s|pub\s+use\s)/.test(l) ? 'yes' : 'no';
      case 'cpp':
      case 'c':
        return /^#(include|define|pragma)/.test(l) ? 'yes' : 'no';
      default:
        return 'no';
    }
  };

  // Scan the top of the file; stop as soon as we see a "no" that follows
  // a "yes". Blank lines and comments are neutral ("maybe").
  let seenImport = false;
  while (i < lines.length && i < 200) { // cap so we don't scan a whole file looking for imports
    const verdict = isImport(lines[i]);
    if (verdict === 'yes') {
      importLines.push(lines[i]);
      seenImport = true;
    } else if (verdict === 'no') {
      if (seenImport) break;
    } else if (verdict === 'maybe') {
      importLines.push(lines[i]);
    }
    i++;
  }

  // Trim trailing blank/comment fluff so the block is tight.
  while (importLines.length > 0 && importLines[importLines.length - 1].trim() === '') {
    importLines.pop();
  }
  return { block: importLines.join('\n'), endLine: importLines.length };
}

// ─── Per-language top-level node extraction ─────────────────────────────────

/**
 * Each language function receives the FULL source and returns an array of
 * `{ name, nodeType, startLine, endLine, content, isExported?, isAsync? }`.
 * Lines are 1-based (matches editor conventions).
 *
 * The strategy: find declarations with a regex, then walk forward by
 * brace-matching (or indentation for Python) to find the end line. It's
 * not 100% robust — template-literal braces and regex-literal braces can
 * fool it — but good enough for retrieval where a slightly over/under
 * cut chunk still contains the function body.
 */

function findBraceEnd(lines, startIdx) {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // Strip line comments and string literals coarsely to avoid
    // counting braces inside them. This is intentionally naive.
    const cleaned = line
      .replace(/\/\/.*$/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"([^"\\]|\\.)*"/g, '""')
      .replace(/'([^'\\]|\\.)*'/g, "''")
      .replace(/`([^`\\]|\\.)*`/g, '``');
    for (const ch of cleaned) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) return i; }
    }
  }
  return lines.length - 1;
}

function extractTsJsNodes(source) {
  const lines = source.split('\n');
  const nodes = [];

  // Matches: `export`/`export default`/`async`/nothing, then
  // `function` | `class` | `interface` | `type` | `const`/`let`/`var` identifier.
  const decl = /^(\s*)(?:(export)\s+(?:default\s+)?)?(async\s+)?(function\*?|class|interface|type|const|let|var)\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const [, , exported, asyncKw, kind, name] = m;

    // `type X = ...` and plain `const X = 5;` are often single-line.
    // Only treat const/let/var as a chunk if its RHS contains `=>` (arrow fn) or `function`.
    if ((kind === 'const' || kind === 'let' || kind === 'var') && !/=>|function/.test(lines[i])) continue;
    if (kind === 'type' && !lines[i].includes('{')) continue;

    // Decide how far the chunk extends:
    //   - Opens a brace on this line (`function f() {`, `class X {`, arrow
    //     with body `=> {`): walk to the matching close via brace balance.
    //   - Single-line arrow without braces (`const f = x => x * 2;`): the
    //     chunk ends on THIS line. Previously we called findBraceEnd anyway,
    //     which walked forward and swallowed everything up to the next
    //     unrelated `{...}` block.
    //   - No brace, no arrow (e.g. a forward declaration): single-line.
    const hasOpenBrace = lines[i].includes('{');
    const hasArrow = /=>/.test(lines[i]);
    let endIdx;
    if (hasOpenBrace) {
      endIdx = findBraceEnd(lines, i);
    } else if (hasArrow) {
      // Arrow without a body brace — either a one-liner with a semicolon
      // on this same line, or the body continues as a single expression.
      // We greedily extend to the first line ending in `;` or `,` or `)`.
      endIdx = i;
      if (!/[;,)]\s*$/.test(lines[i])) {
        for (let j = i + 1; j < lines.length && j < i + 20; j++) {
          if (/[;,)]\s*$/.test(lines[j])) { endIdx = j; break; }
          endIdx = j;
        }
      }
    } else {
      endIdx = i;
    }

    const content = lines.slice(i, endIdx + 1).join('\n');
    const nodeType = kind === 'function' || hasArrow || /function/.test(lines[i]) ? 'function'
                   : kind === 'class' ? 'class'
                   : kind === 'interface' ? 'interface'
                   : kind === 'type' ? 'type'
                   : 'variable';
    // Detect `const x = async (...) => ...` — the outer regex puts
    // (async\s+)? BEFORE the declarator so this case is missed.
    const lineIsAsync = !!asyncKw || /=\s*async\s*[(<]/.test(lines[i]) || /=\s*async\s+function/.test(lines[i]);
    nodes.push({
      name,
      nodeType,
      startLine: i + 1,
      endLine: endIdx + 1,
      content,
      isExported: !!exported,
      isAsync: lineIsAsync,
    });

    // Skip ahead so nested declarations don't also become top-level chunks.
    i = endIdx;
  }
  return nodes;
}

function extractPythonNodes(source) {
  const lines = source.split('\n');
  const nodes = [];
  const decl = /^(\s*)(async\s+)?(def|class)\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const [, indent, asyncKw, kind, name] = m;
    // Only pick up top-level (no indentation) declarations. Nested
    // methods are included within the class chunk.
    if (indent.length !== 0) continue;

    // Walk forward until a non-empty line with indent <= declaration's.
    let endIdx = i;
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === '') { endIdx = j; continue; }
      const leading = ln.match(/^(\s*)/)[1].length;
      if (leading <= indent.length) { endIdx = j - 1; break; }
      endIdx = j;
    }

    nodes.push({
      name,
      nodeType: kind === 'class' ? 'class' : 'function',
      startLine: i + 1,
      endLine: endIdx + 1,
      content: lines.slice(i, endIdx + 1).join('\n'),
      isExported: !name.startsWith('_'),
      isAsync: !!asyncKw,
    });
    i = endIdx;
  }
  return nodes;
}

function extractGoNodes(source) {
  const lines = source.split('\n');
  const nodes = [];
  // func [(recv)] Name(args) { ... }   OR   type Name struct/interface { ... }
  const decl = /^(func(?:\s+\([^)]+\))?\s+(\w+)|type\s+(\w+)\s+(struct|interface))/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const name = m[2] || m[3];
    const nodeType = m[1].startsWith('func') ? 'function' : (m[4] === 'struct' ? 'struct' : 'interface');
    const endIdx = lines[i].includes('{') ? findBraceEnd(lines, i) : i;
    nodes.push({
      name,
      nodeType,
      startLine: i + 1,
      endLine: endIdx + 1,
      content: lines.slice(i, endIdx + 1).join('\n'),
      isExported: /^[A-Z]/.test(name),
    });
    i = endIdx;
  }
  return nodes;
}

function extractBraceLangNodes(source, { functionPattern, classPattern }) {
  const lines = source.split('\n');
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i].match(functionPattern);
    const cl = lines[i].match(classPattern);
    const m = fn || cl;
    if (!m) continue;
    const name = m[1];
    const nodeType = fn ? 'function' : 'class';
    const endIdx = findBraceEnd(lines, i);
    nodes.push({
      name,
      nodeType,
      startLine: i + 1,
      endLine: endIdx + 1,
      content: lines.slice(i, endIdx + 1).join('\n'),
    });
    i = endIdx;
  }
  return nodes;
}

// ─── Sliding window fallback ────────────────────────────────────────────────

function slidingWindowChunks(source, filename, language, { lineChunkSize, lineOverlap }) {
  const lines = source.split('\n');
  if (lines.length === 0) return [];

  const chunks = [];
  const step = Math.max(1, lineChunkSize - lineOverlap);
  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + lineChunkSize, lines.length);
    chunks.push({
      text: lines.slice(i, end).join('\n'),
      startLine: i + 1,
      endLine: end,
      language,
      nodeType: 'other',
      name: null,
      isExported: undefined,
      isAsync: undefined,
      source: filename || null,
    });
    if (end === lines.length) break;
  }
  return chunks;
}

// ─── Public API ─────────────────────────────────────────────────────────────

function chunkCode(filename, content, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  if (!content || typeof content !== 'string') return [];

  const language = opts.language || detectLanguage(filename, content);
  const lines = content.split('\n');
  const { block: importBlock } = config.includeImports
    ? extractImports(lines, language)
    : { block: '' };

  let nodes = [];
  if (language === 'typescript' || language === 'javascript') nodes = extractTsJsNodes(content);
  else if (language === 'python') nodes = extractPythonNodes(content);
  else if (language === 'go') nodes = extractGoNodes(content);
  else if (language === 'java') {
    nodes = extractBraceLangNodes(content, {
      functionPattern: /^\s*(?:public|private|protected|static|final|\s)+\s+[\w<>\[\],\s]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/,
      classPattern: /^\s*(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface)\s+(\w+)/,
    });
  } else if (language === 'rust') {
    nodes = extractBraceLangNodes(content, {
      functionPattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
      classPattern: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/,
    });
  } else if (language === 'cpp' || language === 'c') {
    nodes = extractBraceLangNodes(content, {
      functionPattern: /^\s*(?:static\s+|inline\s+|virtual\s+|explicit\s+|const\s+)?[\w:<>\*\&\s]+\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/,
      classPattern: /^\s*(?:class|struct)\s+(\w+)/,
    });
  }

  // If no structural nodes found, fall back to sliding window.
  if (nodes.length === 0) {
    return slidingWindowChunks(content, filename, language, config);
  }

  const chunks = [];
  for (const node of nodes) {
    if (node.endLine - node.startLine + 1 < config.minLines) continue;

    // Cap absurdly long nodes at maxChars — split down the middle on a
    // blank line so we keep two cohesive halves rather than one megachunk.
    const base = importBlock && config.includeImports
      ? `${importBlock}\n\n${node.content}`
      : node.content;

    if (base.length <= config.maxChars) {
      chunks.push({
        text: base,
        startLine: node.startLine,
        endLine: node.endLine,
        language,
        nodeType: node.nodeType,
        name: node.name,
        isExported: node.isExported,
        isAsync: node.isAsync,
        source: filename || null,
      });
      continue;
    }
    // Split on blank-line boundary around the midpoint.
    const nodeLines = node.content.split('\n');
    const mid = Math.floor(nodeLines.length / 2);
    let splitAt = mid;
    for (let off = 0; off < mid; off++) {
      if (nodeLines[mid + off]?.trim() === '') { splitAt = mid + off; break; }
      if (nodeLines[mid - off]?.trim() === '') { splitAt = mid - off; break; }
    }
    const a = nodeLines.slice(0, splitAt).join('\n');
    const b = nodeLines.slice(splitAt).join('\n');
    chunks.push({
      text: config.includeImports && importBlock ? `${importBlock}\n\n${a}` : a,
      startLine: node.startLine,
      endLine: node.startLine + splitAt - 1,
      language, nodeType: node.nodeType, name: `${node.name}#part1`,
      isExported: node.isExported, isAsync: node.isAsync, source: filename || null,
    });
    chunks.push({
      text: config.includeImports && importBlock ? `${importBlock}\n\n${b}` : b,
      startLine: node.startLine + splitAt,
      endLine: node.endLine,
      language, nodeType: node.nodeType, name: `${node.name}#part2`,
      isExported: node.isExported, isAsync: node.isAsync, source: filename || null,
    });
  }

  return chunks;
}

module.exports = {
  chunkCode,
  detectLanguage,
  // exported for tests
  extractImports,
  extractTsJsNodes,
  extractPythonNodes,
  extractGoNodes,
  findBraceEnd,
  slidingWindowChunks,
  DEFAULTS,
  EXT_TO_LANG,
};
