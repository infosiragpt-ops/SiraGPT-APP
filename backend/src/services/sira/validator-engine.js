/**
 * validator-engine — Cira's deterministic Validator Engine
 * (MASTER_SPEC §5/cira-core/validators/).
 *
 * Five validator families, each with a canonical check vocabulary:
 *
 *   - artifact_validator      file_opens / mime_match / extension_match
 *                             min_pages / min_rows / contains_text /
 *                             format_sovereignty / no_lorem_ipsum
 *   - source_validator        no_fake_doi / doi_or_url_present /
 *                             sources_match_claims / citation_style_correct
 *                             year_recent_enough / domain_authoritative
 *   - code_validator          parses / no_secrets_committed /
 *                             no_dangerous_calls / cyclomatic_under_threshold
 *                             passes_lint / passes_tests / no_syntax_errors
 *   - document_validator      cover_page_present / toc_present / has_h1 /
 *                             headings_hierarchical / references_present /
 *                             tables_render / charts_render
 *   - safety_validator        no_pii_in_logs / no_prompt_injection_response
 *                             respects_robots / no_captcha_bypass /
 *                             no_destructive_action_without_approval
 *
 * Each validator is a PURE function: receives a context (artefact +
 * envelope + claims + sources + code + html + ...) and returns
 * { name, status: passed|failed|warning, score?, detail }.
 *
 * Pure JS, deterministic, zero deps.
 */

const ARTIFACT_CHECKS = Object.freeze([
  "file_opens", "mime_match", "extension_match", "min_pages",
  "min_rows", "min_slides", "min_words", "contains_text",
  "format_sovereignty", "no_lorem_ipsum", "size_reasonable",
]);

const SOURCE_CHECKS = Object.freeze([
  "no_fake_doi", "doi_or_url_present", "sources_match_claims",
  "citation_style_correct", "year_recent_enough", "domain_authoritative",
  "every_claim_has_source", "no_hallucinated_quotes",
]);

const CODE_CHECKS = Object.freeze([
  "parses", "no_secrets_committed", "no_dangerous_calls",
  "cyclomatic_under_threshold", "passes_lint", "passes_tests",
  "no_syntax_errors", "no_unused_imports",
]);

const DOCUMENT_CHECKS = Object.freeze([
  "cover_page_present", "toc_present", "has_h1",
  "headings_hierarchical", "references_present", "tables_render",
  "charts_render", "min_word_count",
]);

const SAFETY_CHECKS = Object.freeze([
  "no_pii_in_logs", "no_prompt_injection_response",
  "respects_robots", "no_captcha_bypass",
  "no_destructive_action_without_approval", "no_self_harm_content",
]);

const ALL_CHECKS = Object.freeze({
  artifact: ARTIFACT_CHECKS, source: SOURCE_CHECKS, code: CODE_CHECKS,
  document: DOCUMENT_CHECKS, safety: SAFETY_CHECKS,
});

// ── Artifact validator ──────────────────────────────────────────────

function validateArtifact({ artifact = null, expected = {}, buffer = null, content = "" } = {}) {
  const checks = [];

  if (expected.required_extension && artifact && artifact.filename) {
    const ext = "." + String(artifact.filename).split(".").pop().toLowerCase();
    checks.push(check("extension_match", ext === expected.required_extension.toLowerCase()
      ? "passed" : "failed", `extension ${ext} vs expected ${expected.required_extension}`));
  }
  if (expected.mime_type && artifact && artifact.mime) {
    checks.push(check("mime_match", artifact.mime === expected.mime_type
      ? "passed" : "failed", `mime ${artifact.mime} vs expected ${expected.mime_type}`));
  }
  if (buffer && Buffer.isBuffer(buffer)) {
    checks.push(check("file_opens", buffer.length > 32 ? "passed" : "failed", `buffer size ${buffer.length}`));
    if (expected.min_size_bytes) {
      checks.push(check("size_reasonable", buffer.length >= expected.min_size_bytes ? "passed" : "failed",
        `${buffer.length}/${expected.min_size_bytes}`));
    }
  }
  if (typeof content === "string" && content.length > 0) {
    if (expected.min_words) {
      const words = content.split(/\s+/).filter(Boolean).length;
      checks.push(check("min_word_count", words >= expected.min_words ? "passed" : "failed", `${words} words`));
    }
    if (expected.contains_text) {
      const arr = Array.isArray(expected.contains_text) ? expected.contains_text : [expected.contains_text];
      const allPresent = arr.every(t => content.includes(String(t)));
      checks.push(check("contains_text", allPresent ? "passed" : "failed", `${arr.length} markers`));
    }
    if (/lorem ipsum|TODO\b|FIXME\b|placeholder/i.test(content)) {
      checks.push(check("no_lorem_ipsum", "failed", "lorem/TODO/FIXME/placeholder detected"));
    } else {
      checks.push(check("no_lorem_ipsum", "passed"));
    }
  }
  return summarize("artifact_validator", checks);
}

// ── Source validator ────────────────────────────────────────────────

function validateSources({ claims = [], sources = [], citation_style = "APA7" } = {}) {
  const checks = [];

  // every claim must reference at least one source id
  if (claims.length > 0) {
    const ungrounded = claims.filter(c => !c.source_id || (c.source_id && !sources.some(s => s.id === c.source_id)));
    checks.push(check("every_claim_has_source",
      ungrounded.length === 0 ? "passed" : "failed",
      `${ungrounded.length}/${claims.length} ungrounded`));
  }

  // doi or url present per source
  if (sources.length > 0) {
    const missing = sources.filter(s => !s.doi && !s.url);
    checks.push(check("doi_or_url_present",
      missing.length === 0 ? "passed" : "warning",
      `${missing.length} sources missing doi/url`));

    // year_recent_enough — last 5 years
    const cutoff = new Date().getUTCFullYear() - 5;
    const stale = sources.filter(s => {
      const y = parseYear(s.year || s.published || "");
      return y && y < cutoff;
    });
    checks.push(check("year_recent_enough",
      stale.length / Math.max(sources.length, 1) < 0.5 ? "passed" : "warning",
      `${stale.length}/${sources.length} older than ${cutoff}`));

    // domain_authoritative — academic/government domains
    const authoritative = sources.filter(s => isAuthoritativeDomain(s.url || s.doi || ""));
    checks.push(check("domain_authoritative",
      authoritative.length / Math.max(sources.length, 1) >= 0.6 ? "passed" : "warning",
      `${authoritative.length}/${sources.length} authoritative`));

    // no fake doi (basic heuristic: 10.xxxx/yyyy pattern)
    const fake = sources.filter(s => s.doi && !/^10\.\d{4,9}\/[\w.\-/:;()<>]+$/i.test(s.doi));
    checks.push(check("no_fake_doi",
      fake.length === 0 ? "passed" : "failed",
      `${fake.length} non-conformant DOIs`));
  }

  // citation style heuristic
  if (citation_style && sources.length > 0) {
    const formatted = sources.filter(s => typeof s.formatted === "string" && s.formatted.length > 0);
    checks.push(check("citation_style_correct",
      formatted.length === sources.length ? "passed" : "warning",
      `${formatted.length}/${sources.length} formatted`));
  }

  return summarize("source_validator", checks);
}

// ── Code validator ──────────────────────────────────────────────────

function validateCode({ source = "", language = "javascript" } = {}) {
  const checks = [];
  if (!source) {
    checks.push(check("parses", "failed", "empty source"));
    return summarize("code_validator", checks);
  }

  // No secrets committed
  const secretPattern = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][\w\-]{16,}['"]/i;
  checks.push(check("no_secrets_committed",
    secretPattern.test(source) ? "failed" : "passed",
    secretPattern.test(source) ? "secret-like literal detected" : null));

  // No dangerous calls
  const dangerous = [
    /\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bchild_process\.exec\s*\(/,
    /\bos\.system\s*\(/, /\bshell\.exec\s*\(/, /\brm\s+-rf\s+\//,
  ];
  const dangerHits = dangerous.filter(re => re.test(source));
  checks.push(check("no_dangerous_calls",
    dangerHits.length === 0 ? "passed" : "failed",
    dangerHits.length > 0 ? `${dangerHits.length} dangerous patterns` : null));

  // Cyclomatic complexity heuristic
  const branches = (source.match(/\b(if|for|while|case|catch|&&|\|\|)\b/g) || []).length;
  const functions = (source.match(/\bfunction\b|=>|def\s+\w+|fn\s+\w+/g) || []).length || 1;
  const complexity = Math.round(branches / functions);
  checks.push(check("cyclomatic_under_threshold",
    complexity <= 10 ? "passed" : complexity <= 15 ? "warning" : "failed",
    `~${complexity} branches/function`));

  // Parses (very loose syntax check)
  if (language === "javascript" || language === "typescript") {
    const opens = (source.match(/\{/g) || []).length;
    const closes = (source.match(/\}/g) || []).length;
    checks.push(check("parses",
      opens === closes ? "passed" : "failed",
      opens === closes ? null : `unbalanced braces: ${opens}↔${closes}`));
  } else {
    checks.push(check("parses", "passed", "skipped for non-JS"));
  }

  return summarize("code_validator", checks);
}

// ── Document validator ──────────────────────────────────────────────

function validateDocument({ html = "", markdown = "", expected = {} } = {}) {
  const checks = [];
  const text = html || markdown || "";
  if (!text) {
    checks.push(check("has_h1", "failed", "empty document"));
    return summarize("document_validator", checks);
  }

  if (expected.cover_page) {
    const hasCover = /<h1\b|^# /m.test(text) || /portada|cover/i.test(text);
    checks.push(check("cover_page_present", hasCover ? "passed" : "failed"));
  }
  if (expected.toc) {
    const hasToc = /tabla\s+de\s+contenidos|table\s+of\s+contents|índice/i.test(text);
    checks.push(check("toc_present", hasToc ? "passed" : "warning"));
  }
  checks.push(check("has_h1", /<h1\b|^# /m.test(text) ? "passed" : "failed"));

  // hierarchical headings
  const levels = [...(text.match(/<h([1-6])\b|^(#{1,6})\s/gm) || [])]
    .map(m => /<h(\d)/.test(m) ? parseInt(RegExp.$1, 10) : (m.match(/^(#+)/) || [])[1].length);
  let prev = 0; let skip = false;
  for (const lvl of levels) { if (prev !== 0 && lvl > prev + 1) skip = true; prev = lvl; }
  checks.push(check("headings_hierarchical", skip ? "warning" : "passed"));

  if (expected.references) {
    const hasRefs = /referenc(es|ias)|bibliograf(ía|ia)/i.test(text);
    checks.push(check("references_present", hasRefs ? "passed" : "failed"));
  }
  if (expected.min_word_count) {
    const words = text.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    checks.push(check("min_word_count", words >= expected.min_word_count ? "passed" : "failed", `${words} words`));
  }
  if (expected.tables) {
    checks.push(check("tables_render", /<table\b|^\|/m.test(text) ? "passed" : "failed"));
  }
  if (expected.charts) {
    checks.push(check("charts_render", /<svg\b|<canvas\b|chart/i.test(text) ? "passed" : "warning"));
  }
  return summarize("document_validator", checks);
}

// ── Safety validator ────────────────────────────────────────────────

function validateSafety({ output = "", actions = [], permissions = [] } = {}) {
  const checks = [];
  // PII detection (simple)
  const piiHits = [
    /\b\d{3}-\d{2}-\d{4}\b/,                    // SSN
    /\b\d{16}\b/,                                // credit card length
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  ].filter(re => re.test(output));
  checks.push(check("no_pii_in_logs", piiHits.length === 0 ? "passed" : "warning", `${piiHits.length} pii markers`));

  // Prompt injection response
  const injection = /(ignore|disregard).{0,30}(previous|above|system).{0,30}(instructions|prompt)/i;
  checks.push(check("no_prompt_injection_response", injection.test(output) ? "failed" : "passed"));

  // Destructive actions
  const destructive = (actions || []).filter(a => /\b(delete|drop|rm\s+-rf|truncate|destroy|publish|send)\b/i.test(String(a.kind || a)));
  checks.push(check("no_destructive_action_without_approval",
    destructive.every(a => a.approved === true) ? "passed" : "failed",
    `${destructive.length} destructive actions`));

  // Robots / captcha bypass attempts
  const bypass = (actions || []).filter(a => /captcha|paywall|bypass|robots/i.test(String(a.kind || a)));
  checks.push(check("respects_robots", bypass.length === 0 ? "passed" : "failed", `${bypass.length} bypass attempts`));
  checks.push(check("no_captcha_bypass", bypass.filter(a => /captcha/i.test(String(a.kind || a))).length === 0 ? "passed" : "failed"));

  return summarize("safety_validator", checks);
}

// ── ValidationFrame compositor ──────────────────────────────────────

/**
 * Compose a ValidationFrame from a set of validator outputs.
 * @param {Array<{validator, checks, score}>} reports
 * @param {number} [minScore=0.85]
 */
function composeValidationFrame(reports = [], minScore = 0.85) {
  const flatChecks = [];
  for (const r of reports) {
    for (const c of r.checks) flatChecks.push({ ...c, validator: r.validator });
  }
  const passed = flatChecks.filter(c => c.status === "passed").length;
  const total = flatChecks.length;
  const score = total === 0 ? 0 : passed / total;
  const failed = flatChecks.filter(c => c.status === "failed");
  const repair = failed.map(f => ({
    action: `repair:${f.name}`,
    reason: f.detail || f.name,
    priority: f.validator === "safety_validator" ? "high" : "medium",
  }));
  return Object.freeze({
    frame_type: "validation_frame",
    checks: flatChecks,
    aggregate_score: round3(score),
    minimum_acceptance_score: minScore,
    ready_to_deliver: score >= minScore && failed.length === 0,
    repair_actions: repair,
    by_validator: reports.map(r => ({ validator: r.validator, score: r.score, total: r.checks.length, failed: r.checks.filter(c => c.status === "failed").length })),
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function check(name, status, detail = null) {
  return { name, status, detail };
}

function summarize(validator, checks) {
  const passed = checks.filter(c => c.status === "passed").length;
  const score = checks.length === 0 ? 0 : passed / checks.length;
  return { validator, checks, score: round3(score) };
}

function parseYear(s) {
  const m = String(s).match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

function isAuthoritativeDomain(urlOrDoi) {
  const t = String(urlOrDoi).toLowerCase();
  if (/^10\.\d{4,9}\//.test(t)) return true; // DOI
  return /\.(edu|gov|ac\.\w+|org)\b/.test(t)
      || /(scielo|redalyc|crossref|pubmed|wiley|springer|elsevier|nature|nih|who|fao|imf|worldbank)\b/.test(t);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = {
  validateArtifact,
  validateSources,
  validateCode,
  validateDocument,
  validateSafety,
  composeValidationFrame,
  ALL_CHECKS,
  ARTIFACT_CHECKS, SOURCE_CHECKS, CODE_CHECKS, DOCUMENT_CHECKS, SAFETY_CHECKS,
};
