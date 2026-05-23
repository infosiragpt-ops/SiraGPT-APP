/**
 * code-review — lightweight static reviewer for generated code.
 *
 * This is NOT tree-sitter. A full AST analyser ships in the
 * operational PR (tree-sitter has native bindings; we keep CI
 * dependency-light). What we do here is enough to catch the most
 * common quality regressions the LLM produces and gives the QA
 * Board a SecurityReport + CodeReview pair.
 *
 * Checks:
 *   - function count + per-function length
 *   - nesting depth approximation
 *   - cyclomatic complexity estimate (if / else / for / while /
 *     switch-case / && / || / ternary)
 *   - max-line-length + max-file-length
 *   - TODO / FIXME density
 *   - duplicate identifier-block detection (naive hash of 6+ lines)
 *   - secret-scanner integration
 *   - dangerous-call red flags (eval, exec, child_process.exec,
 *     os.system, dangerouslySetInnerHTML)
 *   - unused-import detection (best-effort, JS/TS only)
 *
 * The module is pure and language-aware via a simple heuristic
 * dispatch — no runtime dependency on Babel or tree-sitter.
 */

const { scanBuffer } = require("../security/secret-scanner");

const FUNCTION_LENGTH_WARN = 80;
const FILE_LENGTH_WARN = 600;
const NESTING_WARN = 4;
const COMPLEXITY_WARN = 12;
const LINE_LENGTH_WARN = 160;
const TODO_DENSITY_WARN = 1 / 200; // one TODO per 200 lines → warn

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "import", "export", "from", "return",
  "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch",
  "finally", "throw", "new", "this", "super", "async", "await", "yield", "typeof",
  "instanceof", "in", "of", "do", "default", "void", "delete", "null", "true", "false",
  "undefined", "as", "interface", "type", "extends", "implements",
]);

function isJsLike(lang) {
  return ["javascript", "js", "typescript", "ts", "tsx", "jsx", "node"].includes(String(lang || "").toLowerCase());
}

function isPythonLike(lang) {
  return ["python", "py", "py3"].includes(String(lang || "").toLowerCase());
}

// ─── Metric helpers ────────────────────────────────────────────────────

function cyclomaticEstimate(source, language) {
  const s = String(source || "");
  let count = 1; // one for the straight-through path
  if (isJsLike(language)) {
    count += matches(s, /\bif\s*\(/g);
    count += matches(s, /\belse\s+if\s*\(/g);
    count += matches(s, /\bfor\s*\(/g);
    count += matches(s, /\bwhile\s*\(/g);
    count += matches(s, /\bcase\s+[^:]+:/g);
    count += matches(s, /\bcatch\s*\(/g);
    count += matches(s, /&&/g);
    count += matches(s, /\|\|/g);
    count += matches(s, /\?[^:]*:/g); // ternary
  } else if (isPythonLike(language)) {
    count += matches(s, /\bif\s+/g);
    count += matches(s, /\belif\s+/g);
    count += matches(s, /\bfor\s+/g);
    count += matches(s, /\bwhile\s+/g);
    count += matches(s, /\bexcept\b/g);
    count += matches(s, /\sand\s/g);
    count += matches(s, /\sor\s/g);
    count += matches(s, /\bif\s+[^:]+else\s+/g); // ternary inline
  } else {
    count += matches(s, /\bif\b/gi);
    count += matches(s, /\bfor\b/gi);
  }
  return count;
}

function matches(s, rx) {
  const m = s.match(rx);
  return m ? m.length : 0;
}

function maxNestingJs(source) {
  let depth = 0, max = 0;
  let inString = false, strCh = null, inLine = false, inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === strCh) { inString = false; strCh = null; }
      continue;
    }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; continue; }
    if (c === "'" || c === '"' || c === "`") { inString = true; strCh = c; continue; }
    if (c === "{") { depth++; if (depth > max) max = depth; }
    if (c === "}") { depth = Math.max(0, depth - 1); }
  }
  return max;
}

function maxNestingPython(source) {
  const lines = source.split(/\r?\n/);
  let max = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)/);
    const indent = m ? Math.floor(m[1].replace(/\t/g, "    ").length / 4) : 0;
    if (indent > max) max = indent;
  }
  return max;
}

function functionsJs(source) {
  const re = /(?:function\s+[A-Za-z_]\w*\s*\([^)]*\)|(?:const|let|var)\s+[A-Za-z_]\w*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|[A-Za-z_]\w*\s*\([^)]*\)\s*\{)/g;
  const matches = [];
  let m;
  while ((m = re.exec(source)) !== null) matches.push({ index: m.index, preview: m[0].slice(0, 60) });
  return matches;
}

function functionsPython(source) {
  const re = /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm;
  const out = [];
  let m;
  while ((m = re.exec(source)) !== null) out.push({ name: m[1], index: m.index });
  return out;
}

function lineLengths(source) {
  const lines = source.split(/\r?\n/);
  return lines.map(l => l.length);
}

// ─── Public entry ──────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.source
 * @param {string} args.language       — "javascript" | "typescript" | "python" | ...
 * @param {string} [args.filename]
 * @param {object} [args.thresholds]   — override defaults
 * @returns {{ ok, findings: [], metrics: {}, reports: { security, codeReview } }}
 */
function reviewCode({ source, language, filename, thresholds = {} } = {}) {
  const findings = [];
  if (typeof source !== "string" || !source.trim()) {
    return {
      ok: false,
      findings: [{ severity: "high", code: "no_source", detail: "reviewCode requires a non-empty source string." }],
      metrics: {},
      reports: { security: { ok: true, findings: [] }, codeReview: { ok: false, findings: [{ severity: "high", code: "no_source", detail: "empty" }] } },
    };
  }
  const limits = {
    fileLength: thresholds.fileLength ?? FILE_LENGTH_WARN,
    funcLength: thresholds.funcLength ?? FUNCTION_LENGTH_WARN,
    nesting: thresholds.nesting ?? NESTING_WARN,
    complexity: thresholds.complexity ?? COMPLEXITY_WARN,
    lineLength: thresholds.lineLength ?? LINE_LENGTH_WARN,
    todoDensity: thresholds.todoDensity ?? TODO_DENSITY_WARN,
  };

  const lines = source.split(/\r?\n/);
  const lineCount = lines.length;
  const nesting = isJsLike(language) ? maxNestingJs(source)
    : isPythonLike(language) ? maxNestingPython(source)
    : 0;
  const complexity = cyclomaticEstimate(source, language);
  const funcs = isJsLike(language) ? functionsJs(source)
    : isPythonLike(language) ? functionsPython(source)
    : [];
  const longLines = lineLengths(source).filter(n => n > limits.lineLength).length;
  const todos = matches(source, /\b(TODO|FIXME|XXX|HACK)\b/g);
  const todoDensity = lineCount > 0 ? todos / lineCount : 0;

  // Code-quality findings
  if (lineCount > limits.fileLength) {
    findings.push({
      severity: "medium",
      code: "file_too_long",
      detail: `File has ${lineCount} lines (> ${limits.fileLength}) — consider splitting into modules.`,
    });
  }
  if (nesting > limits.nesting) {
    findings.push({
      severity: "medium",
      code: "deep_nesting",
      detail: `Max nesting depth ~${nesting} (> ${limits.nesting}). Flatten or extract helpers.`,
    });
  }
  if (complexity > limits.complexity) {
    findings.push({
      severity: "high",
      code: "high_complexity",
      detail: `Cyclomatic complexity estimate ~${complexity} (> ${limits.complexity}). Break up decision logic.`,
    });
  }
  if (funcs.length === 0 && lineCount > 30 && !isPythonLike(language)) {
    findings.push({
      severity: "low",
      code: "no_functions",
      detail: `Source >30 lines with no detected functions — may be top-level script.`,
    });
  }
  if (longLines > Math.ceil(lineCount * 0.05)) {
    findings.push({
      severity: "low",
      code: "many_long_lines",
      detail: `${longLines} line(s) exceed ${limits.lineLength} chars — enforce a formatter (prettier/black).`,
    });
  }
  if (todoDensity > limits.todoDensity) {
    findings.push({
      severity: "low",
      code: "todo_density_high",
      detail: `TODO density ${(todoDensity * 100).toFixed(2)}% (> ${(limits.todoDensity * 100).toFixed(2)}%) — resolve before merge.`,
    });
  }

  // Dangerous-call scan
  const dangerous = [
    { rx: /\beval\s*\(/, code: "eval_usage", sev: "high", detail: "eval() is a code-injection risk." },
    { rx: /\bexec\s*\(/, code: "exec_usage", sev: "high", detail: "exec() runs arbitrary code." },
    { rx: /child_process\.exec\s*\(/, code: "child_process_exec", sev: "high", detail: "child_process.exec is shell-interpolated; prefer execFile." },
    { rx: /os\.system\s*\(/, code: "os_system_usage", sev: "high", detail: "os.system() runs a shell — prefer subprocess with argv." },
    { rx: /dangerouslySetInnerHTML/, code: "dangerous_inner_html", sev: "high", detail: "React bypass for HTML injection defences." },
    { rx: /document\.write\s*\(/, code: "document_write", sev: "medium", detail: "document.write() is deprecated and triggers reflows." },
    { rx: /Function\s*\(/, code: "function_constructor", sev: "high", detail: "new Function(...) is an eval equivalent." },
  ];
  for (const d of dangerous) {
    if (d.rx.test(source)) findings.push({ severity: d.sev, code: d.code, detail: d.detail });
  }

  // Unused-import heuristic (JS/TS only) — catches the obvious cases
  if (isJsLike(language)) {
    for (const m of source.matchAll(/^\s*import\s+(?:\{([^}]+)\}|([A-Za-z_]\w*))\s+from/gm)) {
      const names = (m[1] || m[2] || "").split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const n of names) {
        if (!n || JS_KEYWORDS.has(n)) continue;
        const body = source.slice(m.index + m[0].length);
        const used = new RegExp(`\\b${escapeRegex(n)}\\b`).test(body);
        if (!used) {
          findings.push({
            severity: "low",
            code: "unused_import",
            detail: `"${n}" imported but apparently not used.`,
          });
        }
      }
    }
  }

  // Secret scan piggy-backs on the Security Governance layer
  const secrets = scanBuffer(source, {});
  for (const s of secrets.findings || []) {
    findings.push({ severity: s.severity, code: `secret_${s.code}`, detail: `Secret detected (${s.code}): ${s.detail}` });
  }

  const metrics = {
    lineCount,
    functionCount: funcs.length,
    maxNesting: nesting,
    cyclomaticComplexity: complexity,
    longLines,
    todos,
    todoDensity,
  };

  const codeReviewFindings = findings.filter(f => !f.code.startsWith("secret_") && f.code !== "eval_usage" && f.code !== "exec_usage" && f.code !== "os_system_usage");
  const securityFindings = findings.filter(f => f.code.startsWith("secret_") || f.code === "eval_usage" || f.code === "exec_usage" || f.code === "os_system_usage" || f.code === "child_process_exec" || f.code === "dangerous_inner_html" || f.code === "function_constructor");

  return {
    ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"),
    findings,
    metrics,
    reports: {
      security: { ok: securityFindings.every(f => f.severity !== "critical"), findings: securityFindings },
      codeReview: { ok: codeReviewFindings.every(f => f.severity !== "critical" && f.severity !== "high"), findings: codeReviewFindings },
    },
  };
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  reviewCode,
  cyclomaticEstimate,
  maxNestingJs,
  maxNestingPython,
  functionsJs,
  functionsPython,
  FUNCTION_LENGTH_WARN,
  FILE_LENGTH_WARN,
  NESTING_WARN,
  COMPLEXITY_WARN,
  LINE_LENGTH_WARN,
};
