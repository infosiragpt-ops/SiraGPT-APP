/**
 * sql-safety — static analysis for raw SQL about to be executed.
 *
 * Policies enforced:
 *   1. READ-ONLY BY DEFAULT — reject any statement that writes,
 *      deletes, creates, alters, truncates, grants, or revokes
 *      unless the caller passes allowWrites:true.
 *   2. PARAMETERISED QUERIES — every literal string that looks
 *      like it was interpolated (single-quoted value containing a
 *      variable-like marker, or unquoted equality with non-literal
 *      suffix) is flagged. The safe path is $1/$2/... or ? bind
 *      placeholders.
 *   3. NO MULTI-STATEMENT — semicolons that separate multiple
 *      statements are flagged (SQL drivers that accept
 *      multiStatement:true have been the source of real breaches).
 *   4. NO DDL IN USER-SCOPED QUERIES — DROP/TRUNCATE/GRANT are
 *      always flagged critical even with allowWrites:true unless
 *      explicitly allowDDL:true.
 *   5. HEURISTIC SQLi PATTERNS — classic ' OR '1'='1, UNION SELECT
 *      fingerprinting, comment-terminated payloads.
 *
 * This is a code analyser, not a query executor. It never opens a
 * connection; the DatabaseConnector feeds it strings and respects
 * the decision before dispatching to a driver.
 */

const READ_ONLY_OPS = ["select", "show", "describe", "explain", "with"];
const WRITE_OPS = ["insert", "update", "delete", "merge", "replace", "upsert", "copy"];
const DDL_OPS = ["create", "drop", "alter", "truncate", "rename", "comment"];
const PRIV_OPS = ["grant", "revoke", "set role"];

/**
 * Parse the leading keyword (after optional CTE opener / whitespace).
 * Multi-token opening commands like "SET ROLE" are matched with
 * word-boundary; unknown tokens fall back to `other`.
 */
function detectLeadingOp(sql) {
  const trimmed = String(sql || "").replace(/^\s+/, "").toLowerCase();
  if (trimmed.startsWith("with")) {
    // CTE: peek after the final SELECT/INSERT... to classify
    const m = trimmed.match(/\)\s*(select|insert|update|delete|merge|create|drop|alter|truncate)\b/);
    if (m) return m[1];
    return "with";
  }
  for (const op of [...READ_ONLY_OPS, ...WRITE_OPS, ...DDL_OPS]) {
    if (new RegExp(`^${op}\\b`).test(trimmed)) return op;
  }
  const priv = trimmed.match(/^(grant|revoke|set\s+role)\b/);
  if (priv) return priv[1].replace(/\s+/, " ");
  return "other";
}

function classifyOp(op) {
  if (READ_ONLY_OPS.includes(op)) return "read";
  if (WRITE_OPS.includes(op)) return "write";
  if (DDL_OPS.includes(op)) return "ddl";
  if (PRIV_OPS.includes(op)) return "priv";
  return "unknown";
}

/**
 * Count semicolons that separate statements (ignoring the trailing
 * one and semicolons inside strings or comments). Returns the
 * statement count — 1 = single, >1 = multi.
 */
function countStatements(sql) {
  let depth = 0;
  let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
  const stmts = [];
  let cur = "";
  const s = String(sql || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      cur += c;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") { inBlockComment = false; cur += c + n; i++; continue; }
      cur += c;
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") {
        // '' escape
        if (n === "'") { cur += n; i++; continue; }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === "\"") inDouble = false;
      continue;
    }
    if (c === "-" && n === "-") { inLineComment = true; cur += c; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; cur += c; continue; }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === "\"") { inDouble = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === ";" && depth === 0) {
      const t = cur.trim();
      if (t) stmts.push(t);
      cur = "";
      continue;
    }
    cur += c;
  }
  const tail = cur.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

/**
 * Detect obvious interpolation patterns the caller should replace
 * with bind parameters. The heuristic deliberately errs on the
 * safe side — false positives are cheaper than a SQLi miss.
 */
function detectInterpolation(sql) {
  const findings = [];
  const s = String(sql || "");

  // JS/Python/Perl-style "${foo}" / "#{foo}" inside single or double quotes
  const tplQuote = /['"][^'"]*(?:\$\{[^}]+\}|#\{[^}]+\})[^'"]*['"]/g;
  let m;
  while ((m = tplQuote.exec(s)) !== null) {
    findings.push({ code: "string_template_interpolation", detail: `interpolated value inside SQL literal: ${m[0].slice(0, 60)}…` });
    if (m.index === tplQuote.lastIndex) tplQuote.lastIndex++;
  }

  // Naive concatenation pattern: 'value_' || some_symbol || 'rest' — only flag
  // when the glue is an identifier (probably a variable), not a column ref.
  const concat = /'[^']*'\s*\|\|\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*\|\|\s*'[^']*'/g;
  while ((m = concat.exec(s)) !== null) {
    findings.push({ code: "concat_interpolation", detail: `suspected variable concatenated into SQL: ${m[0].slice(0, 80)}…` });
    if (m.index === concat.lastIndex) concat.lastIndex++;
  }

  // printf / %s / %d style
  const printf = /'[^']*%[sdifu][^']*'/g;
  while ((m = printf.exec(s)) !== null) {
    findings.push({ code: "printf_placeholder_in_sql", detail: `printf-style placeholder inside SQL literal: ${m[0].slice(0, 60)}…` });
    if (m.index === printf.lastIndex) printf.lastIndex++;
  }

  return findings;
}

/**
 * Classic SQLi signatures. Intentionally narrow — we only flag
 * patterns the caller should NEVER be writing by hand.
 */
function detectInjectionSignatures(sql) {
  const findings = [];
  const s = String(sql || "").toLowerCase();
  if (/'\s*or\s*'1'\s*=\s*'1/.test(s)) findings.push({ code: "classic_or_1_1", detail: "' OR '1'='1' pattern detected" });
  if (/union\s+select\s+null/.test(s)) findings.push({ code: "union_select_null", detail: "UNION SELECT NULL fingerprinting detected" });
  if (/;\s*--/.test(s)) findings.push({ code: "comment_terminated_payload", detail: "; -- payload terminator detected" });
  if (/\/\*.*--\s*\*\//.test(s)) findings.push({ code: "nested_comment_payload", detail: "nested comment payload detected" });
  if (/waitfor\s+delay/.test(s)) findings.push({ code: "sql_timing_attack", detail: "WAITFOR DELAY timing-attack pattern" });
  if (/xp_cmdshell/.test(s)) findings.push({ code: "sql_xp_cmdshell", detail: "xp_cmdshell invocation detected" });
  return findings;
}

function hasBindPlaceholders(sql) {
  const s = String(sql || "");
  return /\$\d+\b/.test(s) || /\?/.test(s) || /:[a-zA-Z_][a-zA-Z_0-9]*/.test(s);
}

/**
 * Main entry point.
 *
 * @param {string} sql
 * @param {object} [opts]
 * @param {boolean} [opts.allowWrites=false]
 * @param {boolean} [opts.allowDDL=false]
 * @param {boolean} [opts.allowMultiStatement=false]
 * @param {object}  [opts.params]
 * @returns {{
 *   ok: boolean,
 *   findings: Array<{severity,code,detail}>,
 *   detectedOperations: string[],
 *   statementCount: number,
 *   classification: "read"|"write"|"ddl"|"priv"|"unknown"|"mixed",
 *   estimatedCost: "low"|"medium"|"high",
 *   usesParameters: boolean,
 * }}
 */
function analyzeSql(sql, opts = {}) {
  const findings = [];
  const statements = countStatements(sql);
  const statementCount = statements.length;
  const leadingOps = statements.map(detectLeadingOp);
  const classes = leadingOps.map(classifyOp);
  const unique = Array.from(new Set(classes));
  const classification = unique.length === 1 ? unique[0] : "mixed";
  const allowWrites = Boolean(opts.allowWrites);
  const allowDDL = Boolean(opts.allowDDL);
  const allowMulti = Boolean(opts.allowMultiStatement);

  if (statementCount === 0) {
    findings.push({ severity: "high", code: "empty_sql", detail: "No SQL provided." });
    return { ok: false, findings, detectedOperations: [], statementCount: 0, classification: "unknown", estimatedCost: "low", usesParameters: false };
  }

  if (statementCount > 1 && !allowMulti) {
    findings.push({
      severity: "critical",
      code: "multi_statement_sql",
      detail: `Multiple SQL statements detected (${statementCount}). Enable allowMultiStatement:true or split into separate calls.`,
    });
  }

  for (let i = 0; i < leadingOps.length; i++) {
    const op = leadingOps[i];
    const klass = classes[i];
    if (klass === "write" && !allowWrites) {
      findings.push({
        severity: "critical",
        code: "write_not_allowed",
        detail: `Write statement "${op}" detected but allowWrites is false.`,
      });
    }
    if (klass === "ddl" && !allowDDL) {
      findings.push({
        severity: "critical",
        code: "ddl_not_allowed",
        detail: `DDL statement "${op}" detected but allowDDL is false.`,
      });
    }
    if (klass === "priv") {
      findings.push({
        severity: "critical",
        code: "privilege_statement",
        detail: `Privilege statement "${op}" is never allowed through the agent.`,
      });
    }
    if (klass === "unknown") {
      findings.push({
        severity: "medium",
        code: "unknown_leading_op",
        detail: `Leading keyword "${op}" is not recognised as a read/write/DDL/priv operation.`,
      });
    }
  }

  for (const f of detectInterpolation(sql)) findings.push({ severity: "critical", ...f });
  for (const f of detectInjectionSignatures(sql)) findings.push({ severity: "critical", ...f });

  const usesParameters = hasBindPlaceholders(sql);
  if (!usesParameters && (classification === "read" || classification === "write")) {
    // Only warn — queries with no dynamic values at all (e.g.
    // "SELECT now()") are still legitimate. Upgrade to HIGH when
    // interpolation is suspected.
    const severity = findings.some(f => f.code.startsWith("string_") || f.code.startsWith("concat_")) ? "high" : "low";
    findings.push({
      severity,
      code: "no_bind_parameters",
      detail: "SQL does not use $1 / ? / :named bind placeholders. If any value came from user input, this is a SQLi risk.",
    });
  }

  const estimatedCost = estimateCost(statements);

  return {
    ok: findings.every(f => f.severity !== "critical" && f.severity !== "high"),
    findings,
    detectedOperations: leadingOps,
    statementCount,
    classification,
    estimatedCost,
    usesParameters,
  };
}

function estimateCost(statements) {
  let cost = "low";
  for (const s of statements) {
    const l = String(s || "").toLowerCase();
    if (l.includes("join") || l.includes("group by") || l.includes("order by")) cost = "medium";
    if (l.includes("select *") && !l.includes("limit")) cost = "high";
    if (l.includes("cross join") || l.includes("full outer join")) cost = "high";
  }
  return cost;
}

module.exports = {
  analyzeSql,
  countStatements,
  detectLeadingOp,
  classifyOp,
  detectInterpolation,
  detectInjectionSignatures,
  hasBindPlaceholders,
  estimateCost,
  READ_ONLY_OPS,
  WRITE_OPS,
  DDL_OPS,
  PRIV_OPS,
};
