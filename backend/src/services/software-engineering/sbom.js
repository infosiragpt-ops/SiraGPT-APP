/**
 * sbom — generate a Software Bill of Materials in CycloneDX 1.5
 * shape (bomFormat JSON) from a project's manifests.
 *
 * Supported inputs:
 *   - package.json (npm / pnpm / yarn)
 *   - package-lock.json (optional; gives resolved versions)
 *   - requirements.txt (Python pip)
 *   - pyproject.toml (PEP 621 / Poetry `[tool.poetry.dependencies]`)
 *
 * Output matches the CycloneDX 1.5 schema closely enough that a
 * caller can pipe the JSON into dependency-track / osv-scanner /
 * cdxgen without adapters. Every component carries a PURL so
 * downstream auditors can resolve it against registries.
 *
 * Pure / offline. No npm / pip / network calls. What we cannot
 * resolve (e.g. a transitive dependency with no lockfile) we mark
 * `resolved: false` so the caller knows not to trust the version.
 */

const crypto = require("crypto");

// ─── Parsers ───────────────────────────────────────────────────────────

function parsePackageJson(text) {
  let pkg;
  try { pkg = JSON.parse(text); }
  catch (err) { return { ok: false, error: `package.json: ${err.message}` }; }
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
  const dev = new Set(Object.keys(pkg.devDependencies || {}));
  const components = [];
  for (const [name, rawVersion] of Object.entries(all)) {
    components.push({
      name,
      version: cleanNpmVersion(rawVersion),
      rawVersion: String(rawVersion),
      scope: dev.has(name) ? "optional" : "required",
      ecosystem: "npm",
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(cleanNpmVersion(rawVersion) || "unknown")}`,
      resolved: false,
    });
  }
  return { ok: true, projectName: pkg.name, projectVersion: pkg.version, components };
}

function parseLockfile(text) {
  try {
    const lock = JSON.parse(text);
    const resolved = new Map();
    // npm v7+ lockfile
    if (lock.packages && typeof lock.packages === "object") {
      for (const [path, meta] of Object.entries(lock.packages)) {
        if (!path || !meta?.version) continue;
        const name = path.replace(/^node_modules\//, "");
        if (!name) continue;
        resolved.set(name, meta.version);
      }
    }
    // legacy
    if (lock.dependencies && typeof lock.dependencies === "object") {
      for (const [name, meta] of Object.entries(lock.dependencies)) {
        if (meta?.version) resolved.set(name, meta.version);
      }
    }
    return resolved;
  } catch { return new Map(); }
}

function cleanNpmVersion(range) {
  const s = String(range || "");
  // accept workspace:*, file:, git+ssh, github: — flag as unresolved
  if (/^(workspace:|file:|link:|git\+|git:|github:|npm:)/i.test(s)) return null;
  const m = s.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : null;
}

function parseRequirementsTxt(text) {
  const components = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>)?\s*([A-Za-z0-9_.\-+]+)?/);
    if (!m) continue;
    const name = m[1];
    const op = m[2] || "";
    const version = m[3] || null;
    components.push({
      name,
      version: op === "==" ? version : null,
      rawVersion: `${op}${version || ""}`,
      scope: "required",
      ecosystem: "pypi",
      purl: `pkg:pypi/${encodeURIComponent(name)}@${encodeURIComponent(op === "==" ? version : "unknown")}`,
      resolved: op === "==" && Boolean(version),
    });
  }
  return { ok: true, components };
}

function parsePyProject(text) {
  // Tiny TOML subset: [tool.poetry.dependencies] / [project.dependencies]
  // For brevity we regex out the standard sections rather than a full
  // TOML parser. If a consumer needs exact parsing they wrap us.
  const components = [];
  const name = (text.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1];
  const version = (text.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1];

  // PEP 621 style: dependencies = ["foo>=1.0", "bar==2.0"]
  const depList = text.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (depList) {
    const inner = depList[1];
    for (const m of inner.matchAll(/"([^"]+)"/g)) {
      const c = parseRequirementsTxt(m[1]).components[0];
      if (c) components.push(c);
    }
  }

  // Poetry: [tool.poetry.dependencies]\nfoo = "^1.0"\nbar = "==2.0"
  const poetrySection = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (poetrySection) {
    for (const line of poetrySection[1].split(/\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*"([^"]+)"/);
      if (!m) continue;
      const op = m[2].startsWith("==") ? "==" : m[2].startsWith("^") ? "^" : m[2].startsWith("~") ? "~" : "";
      const vmatch = m[2].match(/(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)/);
      const version = op === "==" && vmatch ? vmatch[1] : null;
      components.push({
        name: m[1],
        version,
        rawVersion: m[2],
        scope: "required",
        ecosystem: "pypi",
        purl: `pkg:pypi/${encodeURIComponent(m[1])}@${encodeURIComponent(version || "unknown")}`,
        resolved: Boolean(version),
      });
    }
  }
  return { ok: true, projectName: name, projectVersion: version, components };
}

// ─── CycloneDX emitter ─────────────────────────────────────────────────

function generateSbom({ packageJson, packageLock, requirementsTxt, pyprojectToml, projectMeta } = {}) {
  const components = [];
  const warnings = [];
  let project = { name: projectMeta?.name || "unknown", version: projectMeta?.version || "0.0.0" };

  if (packageJson) {
    const r = parsePackageJson(packageJson);
    if (!r.ok) warnings.push(r.error);
    else {
      if (!projectMeta?.name) project.name = r.projectName || project.name;
      if (!projectMeta?.version) project.version = r.projectVersion || project.version;
      // Resolve versions from lockfile when supplied
      if (packageLock) {
        const resolved = parseLockfile(packageLock);
        for (const c of r.components) {
          if (resolved.has(c.name)) {
            c.version = resolved.get(c.name);
            c.purl = `pkg:npm/${encodeURIComponent(c.name)}@${encodeURIComponent(c.version)}`;
            c.resolved = true;
          }
        }
      }
      components.push(...r.components);
    }
  }
  if (requirementsTxt) components.push(...(parseRequirementsTxt(requirementsTxt).components || []));
  if (pyprojectToml) {
    const r = parsePyProject(pyprojectToml);
    if (!projectMeta?.name) project.name = r.projectName || project.name;
    if (!projectMeta?.version) project.version = r.projectVersion || project.version;
    components.push(...r.components);
  }

  // CycloneDX 1.5 JSON
  const serialNumber = "urn:uuid:" + uuidFromSeed(`${project.name}:${project.version}:${components.length}`);
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "siraGPT", name: "sbom-generator", version: "1.0.0" }],
      component: {
        "bom-ref": `root:${project.name}@${project.version}`,
        type: "application",
        name: project.name,
        version: project.version,
      },
    },
    components: components.map(c => ({
      "bom-ref": `${c.ecosystem}:${c.name}@${c.version || "unknown"}`,
      type: "library",
      name: c.name,
      version: c.version || "unknown",
      purl: c.purl,
      scope: c.scope,
      properties: [
        { name: "sira:ecosystem", value: c.ecosystem },
        { name: "sira:resolved", value: String(Boolean(c.resolved)) },
        { name: "sira:rawVersion", value: c.rawVersion },
      ],
    })),
    compositions: [{
      aggregate: components.some(c => !c.resolved) ? "incomplete" : "complete",
      assemblies: [`root:${project.name}@${project.version}`],
    }],
  };

  return {
    ok: true,
    sbom,
    warnings,
    stats: {
      total: components.length,
      byEcosystem: tally(components, "ecosystem"),
      resolved: components.filter(c => c.resolved).length,
      unresolved: components.filter(c => !c.resolved).length,
    },
  };
}

function tally(arr, key) {
  const out = {};
  for (const a of arr) out[a[key]] = (out[a[key]] || 0) + 1;
  return out;
}

function uuidFromSeed(seed) {
  const h = crypto.createHash("sha1").update(String(seed)).digest("hex");
  // 8-4-4-4-12 layout
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

module.exports = {
  generateSbom,
  parsePackageJson,
  parseLockfile,
  parseRequirementsTxt,
  parsePyProject,
  cleanNpmVersion,
};
