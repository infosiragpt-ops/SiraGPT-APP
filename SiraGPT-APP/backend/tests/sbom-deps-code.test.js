/**
 * sbom-deps-code regression — deterministic tests for the Software
 * Engineering Pipeline: SBOM generator, dependency auditor, code
 * reviewer. No network.
 */

const { strict: assert } = require("assert");

const {
  generateSbom,
  parsePackageJson,
  parseRequirementsTxt,
  parsePyProject,
  parseLockfile,
  cleanNpmVersion,
} = require("../src/services/software-engineering/sbom");
const {
  auditSbom,
  DEPRECATED_NPM,
  COPYLEFT_LICENSES,
} = require("../src/services/software-engineering/dependency-audit");
const {
  reviewCode,
  cyclomaticEstimate,
  maxNestingJs,
  functionsJs,
} = require("../src/services/software-engineering/code-review");

const SAMPLE_PKG = JSON.stringify({
  name: "my-app",
  version: "1.2.3",
  dependencies: { lodash: "^4.17.21", express: "4.18.2" },
  devDependencies: { jest: "^29" },
});

const SAMPLE_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/lodash":  { version: "4.17.21" },
    "node_modules/express": { version: "4.18.2" },
    "node_modules/jest":    { version: "29.7.0" },
  },
});

const SAMPLE_REQS = `# requirements\nrequests==2.31.0\nnumpy>=1.24\npandas\n`;

const SAMPLE_PYPROJECT = `
[project]
name = "demo"
version = "0.2.1"
dependencies = ["fastapi>=0.110", "pydantic==2.6.1"]
[tool.poetry.dependencies]
requests = "==2.31.0"
cachetools = "^5.3"
`;

const cases = [
  // ── SBOM parsers ──────────────────────────────────────────────────
  () => {
    assert.equal(cleanNpmVersion("^4.17.21"), "4.17.21");
    assert.equal(cleanNpmVersion("workspace:*"), null);
    assert.equal(cleanNpmVersion("git+ssh://..."), null);
  },

  () => {
    const r = parsePackageJson(SAMPLE_PKG);
    assert.equal(r.ok, true);
    assert.equal(r.projectName, "my-app");
    assert.equal(r.components.length, 3);
    const jest = r.components.find(c => c.name === "jest");
    assert.equal(jest.scope, "optional");
    assert.equal(jest.ecosystem, "npm");
  },

  () => {
    const map = parseLockfile(SAMPLE_LOCK);
    assert.equal(map.get("lodash"), "4.17.21");
    assert.equal(map.get("express"), "4.18.2");
  },

  () => {
    const r = parseRequirementsTxt(SAMPLE_REQS);
    assert.equal(r.components.length, 3);
    assert.equal(r.components[0].name, "requests");
    assert.equal(r.components[0].resolved, true);
    assert.equal(r.components[1].resolved, false, ">= is not pinned");
  },

  () => {
    const r = parsePyProject(SAMPLE_PYPROJECT);
    assert.equal(r.projectName, "demo");
    assert.ok(r.components.find(c => c.name === "fastapi"));
    assert.ok(r.components.find(c => c.name === "pydantic" && c.resolved === true));
    assert.ok(r.components.find(c => c.name === "requests" && c.resolved === true));
  },

  // ── SBOM generator ────────────────────────────────────────────────
  () => {
    const r = generateSbom({ packageJson: SAMPLE_PKG, packageLock: SAMPLE_LOCK });
    assert.equal(r.ok, true);
    assert.equal(r.sbom.bomFormat, "CycloneDX");
    assert.equal(r.sbom.specVersion, "1.5");
    assert.ok(r.sbom.serialNumber.startsWith("urn:uuid:"));
    assert.equal(r.sbom.metadata.component.name, "my-app");
    assert.equal(r.sbom.metadata.component.version, "1.2.3");
    assert.equal(r.sbom.components.length, 3);
    const lodash = r.sbom.components.find(c => c.name === "lodash");
    assert.equal(lodash.version, "4.17.21");
    assert.equal(lodash.purl, "pkg:npm/lodash@4.17.21");
    assert.equal(r.stats.resolved, 3);
    assert.equal(r.stats.unresolved, 0);
    assert.equal(r.sbom.compositions[0].aggregate, "complete");
  },

  () => {
    // No lockfile → aggregate becomes incomplete
    const r = generateSbom({ packageJson: SAMPLE_PKG });
    assert.equal(r.sbom.compositions[0].aggregate, "incomplete");
    assert.ok(r.stats.unresolved >= 1);
  },

  () => {
    // Combines npm + pypi
    const r = generateSbom({ packageJson: SAMPLE_PKG, requirementsTxt: SAMPLE_REQS });
    const ecosystems = new Set(r.sbom.components.map(c => c.properties.find(p => p.name === "sira:ecosystem")?.value));
    assert.ok(ecosystems.has("npm") && ecosystems.has("pypi"));
  },

  () => {
    const r = generateSbom({});
    assert.equal(r.ok, true);
    assert.equal(r.sbom.components.length, 0);
  },

  // ── Dependency audit ──────────────────────────────────────────────
  () => {
    const sbom = generateSbom({ packageJson: SAMPLE_PKG, packageLock: SAMPLE_LOCK }).sbom;
    const a = auditSbom({ sbom });
    // Without license metadata every component triggers license_unknown (low)
    assert.ok(a.findings.some(f => f.code === "license_unknown"));
    // No critical / high expected for a clean sample
    assert.equal(a.counts.critical || 0, 0);
    assert.equal(a.counts.high || 0, 0);
  },

  () => {
    const sbom = generateSbom({ packageJson: SAMPLE_PKG, packageLock: SAMPLE_LOCK }).sbom;
    const a = auditSbom({
      sbom,
      licenseMap: { lodash: "MIT", express: "MIT", jest: "GPL-3.0" },
    });
    assert.ok(a.findings.some(f => f.code === "copyleft_license"));
    assert.equal(a.ok, false);
  },

  () => {
    // Unresolved ranges flagged
    const sbom = generateSbom({ packageJson: SAMPLE_PKG }).sbom; // no lockfile
    const a = auditSbom({ sbom });
    assert.ok(a.findings.some(f => f.code === "version_unresolved"));
  },

  () => {
    // Deprecated package lands as high
    const deprecatedPkg = JSON.stringify({
      name: "bad", version: "1.0.0",
      dependencies: { request: "^2.88.0" },
    });
    const sbom = generateSbom({ packageJson: deprecatedPkg }).sbom;
    const a = auditSbom({ sbom, licenseMap: { request: "MIT" } });
    assert.ok(a.findings.some(f => f.code === "deprecated_package" && f.severity === "high"));
    assert.ok(DEPRECATED_NPM.has("request"));
  },

  () => {
    // Duplicate versions detected
    const pkg = JSON.stringify({
      name: "dup", version: "1",
      dependencies: { foo: "1.0.0" },
      devDependencies: {},
    });
    const lock = JSON.stringify({
      packages: {
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/bar/node_modules/foo": { version: "2.0.0" },
      },
    });
    const sbom = generateSbom({ packageJson: pkg, packageLock: lock }).sbom;
    // Our parser collapses duplicates onto same name; simulate
    // duplicate-version by manually appending a second component.
    sbom.components.push({
      "bom-ref": "npm:foo@2.0.0",
      type: "library",
      name: "foo",
      version: "2.0.0",
      purl: "pkg:npm/foo@2.0.0",
      scope: "required",
      properties: [
        { name: "sira:ecosystem", value: "npm" },
        { name: "sira:resolved", value: "true" },
        { name: "sira:rawVersion", value: "2.0.0" },
      ],
    });
    const a = auditSbom({ sbom, licenseMap: { foo: "MIT" } });
    assert.ok(a.findings.some(f => f.code === "duplicate_package_versions"));
  },

  () => {
    assert.ok(COPYLEFT_LICENSES.has("GPL-3.0"));
    assert.ok(COPYLEFT_LICENSES.has("AGPL-3.0"));
  },

  // ── Code reviewer ─────────────────────────────────────────────────
  () => {
    const src = `
function add(a, b) { return a + b }
const log = (s) => console.log(s);
export default function run(values) {
  for (const v of values) if (v > 0) log(v);
}
`;
    const r = reviewCode({ source: src, language: "javascript" });
    assert.equal(r.ok, true, `clean code should pass: ${JSON.stringify(r.findings)}`);
    assert.ok(r.metrics.functionCount >= 2);
  },

  () => {
    const src = "function bad(x) { return eval(x) }";
    const r = reviewCode({ source: src, language: "javascript" });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "eval_usage"));
    assert.ok(r.reports.security.findings.some(f => f.code === "eval_usage"));
  },

  () => {
    const src = `
import { foo, bar } from "./m";
console.log(foo());
`;
    const r = reviewCode({ source: src, language: "typescript" });
    assert.ok(r.findings.some(f => f.code === "unused_import" && /bar/.test(f.detail)));
  },

  () => {
    const src = "const KEY = 'AKIAIOSFODNN7EXAMPLE';";
    const r = reviewCode({ source: src, language: "javascript" });
    assert.ok(r.findings.some(f => f.code.startsWith("secret_")));
    assert.ok(r.reports.security.findings.length >= 1);
  },

  () => {
    // Deep nesting triggers the nesting warning
    const deep = `function f(){if(a){if(b){if(c){if(d){if(e){return 1}}}}}}`;
    const r = reviewCode({ source: deep.repeat(2), language: "javascript" });
    assert.ok(r.metrics.maxNesting >= 5);
    assert.ok(r.findings.some(f => f.code === "deep_nesting"));
  },

  () => {
    // Cyclomatic complexity
    const branching = `
function big(x){
  if(x>0){} else if(x<0){} else {}
  for(let i=0;i<x;i++){ if(i%2==0){} }
  while(x>0){ x-- }
  switch(x){ case 1: break; case 2: break; case 3: break; }
  return x > 0 && x < 100 ? (x%2 ? 1 : 2) : 0;
}
`;
    const c = cyclomaticEstimate(branching, "javascript");
    assert.ok(c >= 10, `expected high complexity, got ${c}`);
    const r = reviewCode({ source: branching.repeat(2), language: "javascript" });
    assert.ok(r.findings.some(f => f.code === "high_complexity"));
  },

  () => {
    // Python surface
    const src = `def area(r):\n    return 3.14*r*r\n\nif __name__=='__main__':\n    print(area(2))`;
    const r = reviewCode({ source: src, language: "python" });
    assert.equal(r.metrics.functionCount, 1);
  },

  () => {
    // Functions JS detection captures multiple forms
    const src = `
function a(){}
const b = () => {};
export async function c(){}
class Foo { method() {} }
`;
    const fs = functionsJs(src);
    assert.ok(fs.length >= 3);
  },

  () => {
    // maxNestingJs ignores braces inside strings / comments
    const src = `
const s = "{{{{{{";  // {{{
const t = \`\${x} {\`;
function f() { return 1 }
`;
    const depth = maxNestingJs(src);
    assert.ok(depth <= 1);
  },

  () => {
    // Empty source is rejected
    const r = reviewCode({ source: "", language: "javascript" });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "no_source"));
  },

  () => {
    // Very long file
    const longSrc = Array.from({ length: 700 }, (_, i) => `const x${i}=${i};`).join("\n");
    const r = reviewCode({ source: longSrc, language: "javascript" });
    assert.ok(r.findings.some(f => f.code === "file_too_long"));
  },

  () => {
    // Dangerous call in JSX
    const r = reviewCode({ source: `<div dangerouslySetInnerHTML={{__html: s}} />`, language: "tsx" });
    assert.ok(r.findings.some(f => f.code === "dangerous_inner_html"));
  },
];

(async () => {
  let passed = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    try { await cases[i](); passed++; }
    catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
  }
  console.log(`sbom-deps-code regression: ${passed}/${cases.length} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
