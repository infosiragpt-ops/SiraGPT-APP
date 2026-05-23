/**
 * security-db-foundation regression — deterministic tests for the
 * secret scanner, OWASP ASVS evaluator, and SQL safety analyser.
 * No network, no DB, no LLM.
 */

const { strict: assert } = require("assert");

const { scanBuffer, scanJson, PATTERNS } = require("../src/services/security/secret-scanner");
const { evaluateAsvs, ASVS_CONTROLS, listControls } = require("../src/services/security/owasp-asvs");
const { analyzeSql, countStatements, classifyOp, detectLeadingOp } = require("../src/services/db/sql-safety");
const { getComponent, assertRegistryIntegrity } = require("../src/services/agents/component-registry");

const cases = [
  // ── secret-scanner ────────────────────────────────────────────────
  () => {
    const r = scanBuffer("nothing secret here\njust code\nconsole.log('ok')");
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 0);
  },

  () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const r = scanBuffer(`AWS_KEY = ${key}`);
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "aws_access_key" && f.severity === "critical"));
  },

  () => {
    const token = "ghp_" + "A".repeat(36);
    const r = scanBuffer(`token=${token}`);
    assert.ok(r.findings.some(f => f.code === "github_pat"));
    assert.ok(!r.findings.some(f => /ghp_AAAA/.test(f.match)), "redaction should hide the full token");
  },

  () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE..." ;
    const r = scanBuffer(pem);
    assert.ok(r.findings.some(f => f.code === "private_key_pem"));
  },

  () => {
    const r = scanBuffer("sk-ant-" + "x".repeat(100));
    assert.ok(r.findings.some(f => f.code === "anthropic_key" && f.severity === "critical"));
  },

  () => {
    const r = scanJson({ config: { api_key: "sk-" + "A".repeat(48) } });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.path && f.path.includes("api_key")));
  },

  () => {
    // Redaction should never contain the raw secret in its output
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const r = scanBuffer(secret);
    const matched = r.findings.map(f => f.match).join(" ");
    assert.ok(!matched.includes("FODNN7EX"), "redaction must hide middle of the token");
  },

  () => {
    // ignorePatterns skips selected scanners
    const key = "AKIAIOSFODNN7EXAMPLE";
    const r = scanBuffer(key, { ignorePatterns: ["aws_access_key"] });
    assert.equal(r.ok, true, "ignorePatterns should suppress the AWS-key rule");
  },

  // ── OWASP ASVS ────────────────────────────────────────────────────
  () => {
    const list = listControls();
    assert.ok(list.length >= 10, "expected at least 10 ASVS controls");
    assert.ok(list.some(c => c.hasEvaluator), "at least one control should have an evaluator");
  },

  () => {
    // All evaluators short-circuit gracefully without context
    const r = evaluateAsvs({ context: {} });
    assert.ok(r.evaluated >= 1, "some evaluators should run even with empty context");
    assert.ok(r.manual >= 1, "some controls should be manual-review");
  },

  () => {
    // Good context → evaluators pass
    const ctx = {
      passwordPolicy: { minLength: 14 },
      rateLimits: { login: { windowMs: 60000, max: 5 } },
      authMiddleware: { serverSide: true },
      rbac: { roles: ["admin", "user"] },
      inputValidators: { positiveSchema: true },
      sqlGovernance: { parameterisedOnly: true },
      outputEncoding: { contextAware: true },
      logRedaction: { secretsMasked: true },
      tls: { minVersion: 1.3 },
      dependencyAudit: { lastRunOk: true, lastRunAt: "2026-04-24" },
    };
    const r = evaluateAsvs({ context: ctx });
    assert.equal(r.ok, true, `ok should be true for good context, failed=${r.failed}, findings=${JSON.stringify(r.findings).slice(0,240)}`);
    assert.equal(r.failed, 0);
    assert.ok(r.passed >= 5);
  },

  () => {
    // Missing password policy → V2.1.1 fails
    const r = evaluateAsvs({ context: { passwordPolicy: { minLength: 6 } }, onlyControls: ["V2.1.1"] });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "asvs_V2.1.1"));
  },

  () => {
    // onlyControls respected
    const r = evaluateAsvs({ onlyControls: ["V2.1.1"], context: { passwordPolicy: { minLength: 20 } } });
    assert.ok(r.evaluated <= 1);
  },

  // ── SQL safety ────────────────────────────────────────────────────
  () => {
    const r = analyzeSql("SELECT id, name FROM users WHERE id = $1", {});
    assert.equal(r.ok, true);
    assert.equal(r.classification, "read");
    assert.equal(r.usesParameters, true);
  },

  () => {
    const r = analyzeSql("DELETE FROM users WHERE id = 1");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "write_not_allowed"));
  },

  () => {
    const r = analyzeSql("DROP TABLE users");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "ddl_not_allowed"));
  },

  () => {
    const r = analyzeSql("GRANT ALL ON users TO guest");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "privilege_statement"));
  },

  () => {
    const r = analyzeSql("SELECT * FROM users; DELETE FROM logs");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "multi_statement_sql"));
  },

  () => {
    const r = analyzeSql("SELECT * FROM users WHERE name = 'Bob' OR '1'='1'");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "classic_or_1_1"));
  },

  () => {
    const r = analyzeSql("SELECT * FROM products UNION SELECT null, null, null");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "union_select_null"));
  },

  () => {
    const r = analyzeSql("SELECT x FROM t WHERE y = '${user_input}'");
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "string_template_interpolation"));
  },

  () => {
    // allowWrites:true accepts an UPDATE
    const r = analyzeSql("UPDATE users SET active = $1 WHERE id = $2", { allowWrites: true });
    assert.equal(r.classification, "write");
    assert.equal(r.usesParameters, true);
    assert.ok(r.findings.every(f => f.severity !== "critical"));
  },

  () => {
    assert.equal(classifyOp("select"), "read");
    assert.equal(classifyOp("insert"), "write");
    assert.equal(classifyOp("drop"), "ddl");
    assert.equal(classifyOp("grant"), "priv");
  },

  () => {
    const stmts = countStatements("SELECT 1; SELECT 2 /* ; inside comment */; SELECT 3");
    assert.equal(stmts.length, 3);
  },

  () => {
    // Semicolon inside a string literal is not a statement boundary
    const stmts = countStatements("SELECT ';' FROM dual");
    assert.equal(stmts.length, 1);
  },

  () => {
    // detectLeadingOp peels the CTE opener and finds the real op
    assert.equal(detectLeadingOp("WITH t AS (SELECT 1) DELETE FROM users"), "delete");
  },

  // ── registry reflects reality ────────────────────────────────────
  () => {
    assertRegistryIntegrity();
    const sec = getComponent("security-governance-layer");
    assert.equal(sec.status, "partial");
    assert.ok(sec.backing_modules.length >= 2);
    const db = getComponent("database-connector-layer");
    assert.equal(db.status, "partial");
    assert.ok(db.backing_modules.length >= 1);
  },
];

let passed = 0, failed = 0;
const failures = [];
cases.forEach((fn, i) => {
  try { fn(); passed++; }
  catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
});

console.log(`security-db-foundation regression: ${passed}/${cases.length} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
