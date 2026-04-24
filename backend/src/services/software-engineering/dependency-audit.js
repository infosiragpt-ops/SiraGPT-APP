/**
 * dependency-audit — static audit of a Software Bill of Materials
 * (see sbom.js) against a deterministic ruleset.
 *
 * What we flag (pure / offline):
 *   - Unpinned versions (^, ~, >=, caret, tilde, *) for prod deps
 *   - Unresolved dependencies (workspace:, file:, git+, local)
 *   - Known-dangerous or deprecated packages (small hardcoded list)
 *   - Copyleft / unknown licenses (requires license to be passed in)
 *   - Duplicate components under different versions
 *   - Missing project name / version in the SBOM metadata
 *
 * Not attempted here (network / OSV-needed):
 *   - CVE matching → feed the SBOM to osv-scanner / dependency-track
 *   - Actual license resolution from the registry
 *
 * The output shape matches the ValidationFabric's SecurityReport /
 * CodeReview schema so the Agentic QA Board can aggregate it.
 */

const PERMISSIVE_LICENSES = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib",
  "CC0-1.0", "Unlicense", "BSD-3-Clause-Clear",
]);

const COPYLEFT_LICENSES = new Set([
  "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later",
  "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later",
  "LGPL-2.1", "LGPL-3.0", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later",
  "EUPL-1.1", "EUPL-1.2",
]);

// A small hardcoded list of widely-known deprecated or malicious
// packages. A real deploy would replace this with a live feed from
// npm/PyPI advisories — pure data here keeps the audit deterministic
// and CI-runnable.
const DEPRECATED_NPM = new Set([
  "request", "node-uuid", "left-pad", "jquery.ui.draggable",
  "mkdirp-promise", "har-validator", "urix", "querystring",
]);
const DEPRECATED_PYPI = new Set([
  "distribute", "MySQL-python", "south", "mongoengine<0.20",
]);

/**
 * @param {object} args
 * @param {object} args.sbom — output from generateSbom (CycloneDX 1.5)
 * @param {object} [args.licenseMap] — { "pkg@version": "SPDX-Id" }
 * @param {object} [args.options]
 * @param {boolean} [args.options.allowCopyleft=false]
 * @returns {{ ok, findings: Array, stats, counts }}
 */
function auditSbom({ sbom, licenseMap = {}, options = {} } = {}) {
  const findings = [];
  if (!sbom || !sbom.components || !Array.isArray(sbom.components)) {
    return { ok: false, findings: [{ severity: "high", code: "bad_sbom", detail: "auditSbom: sbom.components (array) required" }], stats: {}, counts: {} };
  }

  if (!sbom.metadata?.component?.name || sbom.metadata.component.name === "unknown") {
    findings.push({ severity: "medium", code: "sbom_project_name_missing", detail: "SBOM metadata.component.name is missing; audit traceability limited." });
  }

  // Duplicate component names at different versions (risk of dep hell)
  const byName = new Map();
  for (const c of sbom.components) {
    const key = c.name;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(c.version);
  }
  for (const [name, versions] of byName) {
    if (versions.size > 1) {
      findings.push({
        severity: "medium",
        code: "duplicate_package_versions",
        detail: `"${name}" appears at ${versions.size} distinct versions: ${[...versions].join(", ")}.`,
      });
    }
  }

  for (const c of sbom.components) {
    const ecosystem = propValue(c, "sira:ecosystem") || "unknown";
    const resolved = propValue(c, "sira:resolved") === "true";
    const rawVersion = propValue(c, "sira:rawVersion") || c.version;

    // Unresolved / opaque version
    if (!resolved) {
      findings.push({
        severity: "medium",
        code: "version_unresolved",
        detail: `${c.name}@${rawVersion} is not pinned to a concrete version (ecosystem=${ecosystem}). Commit a lockfile or use "==" / exact version.`,
      });
    }

    // Loose npm ranges on a prod dep
    if (ecosystem === "npm" && c.scope === "required" && /^[\^~*>]/.test(String(rawVersion || ""))) {
      findings.push({
        severity: "low",
        code: "loose_npm_range",
        detail: `${c.name}@${rawVersion} uses a loose range on a prod dep — supply chain risk.`,
      });
    }

    // Deprecated packages
    if (ecosystem === "npm" && DEPRECATED_NPM.has(c.name)) {
      findings.push({
        severity: "high",
        code: "deprecated_package",
        detail: `${c.name} is on the deprecated-npm list — replace it.`,
      });
    }
    if (ecosystem === "pypi" && DEPRECATED_PYPI.has(c.name)) {
      findings.push({
        severity: "high",
        code: "deprecated_package",
        detail: `${c.name} is on the deprecated-pypi list — replace it.`,
      });
    }

    // License classification
    const license = licenseMap[`${c.name}@${c.version}`] || licenseMap[c.name] || null;
    if (license) {
      const id = String(license).trim();
      if (COPYLEFT_LICENSES.has(id) && !options.allowCopyleft) {
        findings.push({
          severity: "high",
          code: "copyleft_license",
          detail: `${c.name}@${c.version} is ${id} (copyleft). Not allowed unless options.allowCopyleft:true.`,
        });
      } else if (!PERMISSIVE_LICENSES.has(id) && !COPYLEFT_LICENSES.has(id)) {
        findings.push({
          severity: "medium",
          code: "unknown_license",
          detail: `${c.name}@${c.version} carries license "${id}" which is not on the permissive/copyleft allowlist — manual review.`,
        });
      }
    } else {
      findings.push({
        severity: "low",
        code: "license_unknown",
        detail: `${c.name}@${c.version} has no license metadata supplied.`,
      });
    }
  }

  const stats = {
    totalComponents: sbom.components.length,
    unresolved: sbom.components.filter(c => propValue(c, "sira:resolved") !== "true").length,
    duplicateNames: [...byName.values()].filter(s => s.size > 1).length,
  };

  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  return {
    ok: counts.critical === 0 && counts.high === 0,
    findings,
    stats,
    counts,
  };
}

function propValue(component, key) {
  const prop = (component.properties || []).find(p => p.name === key);
  return prop ? prop.value : null;
}

module.exports = {
  auditSbom,
  PERMISSIVE_LICENSES,
  COPYLEFT_LICENSES,
  DEPRECATED_NPM,
  DEPRECATED_PYPI,
};
