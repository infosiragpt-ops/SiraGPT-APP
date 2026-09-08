'use strict';

// Research inventory only. This module never clones, installs or executes upstream code.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SHA = /^[a-f0-9]{40}$/;
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'PostgreSQL']);

function validateSources(source) {
  if (source?.schemaVersion !== 1 || !Array.isArray(source.entries) || !source.entries.length) throw new Error('invalid inventory');
  const seen = new Set();
  for (const entry of source.entries) {
    if (!SLUG.test(entry.slug) || seen.has(entry.slug.toLowerCase())) throw new Error('invalid or duplicate slug');
    seen.add(entry.slug.toLowerCase());
    if (!['existing', 'sandbox', 'harness', 'builder', 'ui', 'context', 'orchestration', 'browser', 'models', 'quality', 'blocked', 'binary-only'].includes(entry.category)) throw new Error('invalid category');
    if (typeof entry.intent !== 'string' || !entry.intent.trim() || typeof entry.target !== 'string' || !entry.target.trim()) throw new Error('missing integration intent');
    if (entry.target.startsWith('/') || entry.target.split('/').includes('..')) throw new Error('invalid destination');
  }
  return source;
}

function assess(entry, record) {
  if (entry.category === 'blocked') return 'operator-blocked';
  if (entry.category === 'binary-only') return 'binary-review-only';
  if (entry.category === 'models') return 'reference-only';
  if (!SHA.test(record.commit || '') || !record.licenseEvidence) return 'unverified-no-copy';
  // A root SPDX label is not module/transitive/license-obligations approval.
  if (!ALLOWED.has(record.licenseEvidence.spdx)) return 'license-review-no-copy';
  return 'module-review-required';
}

function licenseEvidence(repo, commit, result) {
  if (!SLUG.test(repo) || !SHA.test(commit) || result?.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('invalid license evidence');
  const name = result.path;
  if (typeof name !== 'string' || !name.length || name.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\\]/.test(name)) throw new Error('invalid license path');
  const bytes = Buffer.from(result.content, 'base64');
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('invalid license length');
  const oid = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  if (result.sha !== oid) throw new Error('license git blob mismatch');
  return {
    path: name, spdx: result.license?.spdx_id || 'UNKNOWN', blobSha: oid,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    url: `https://github.com/${repo}/blob/${commit}/${name.split('/').map(encodeURIComponent).join('/')}`,
    reviewedModulePaths: [],
  };
}

async function github(endpoint) {
  try {
    const { stdout } = await run(process.env.OSS_CATALOG_GH || 'gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // Never emit stderr: authentication/tool configuration can contain private data.
    const status = String(error.stderr || '').match(/HTTP (\d{3})/);
    const safe = new Error(status ? `github-http-${status[1]}` : 'github-request-failed');
    throw safe;
  }
}

async function collectOne(entry, request = github) {
  if (!SLUG.test(entry.slug)) throw new Error('invalid slug');
  const result = { slug: entry.slug, canonical: null, commit: null, archived: null, licenseEvidence: null, issues: [], newSourceFilesImported: 0 };
  try {
    const repo = await request(`repos/${entry.slug}`);
    if (!SLUG.test(repo.full_name) || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error('invalid repository response');
    result.canonical = repo.full_name;
    result.archived = repo.archived === true;
    const revision = await request(`repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`);
    if (!SHA.test(revision.sha || '')) throw new Error('invalid revision');
    result.commit = revision.sha;
    const license = await request(`repos/${repo.full_name}/license?ref=${revision.sha}`);
    result.licenseEvidence = licenseEvidence(repo.full_name, revision.sha, license);
  } catch (error) {
    if (/^github-http-(401|403|429)$/.test(error.message)) throw error;
    result.issues.push(/^github-http-\d{3}$/.test(error.message) ? error.message : 'evidence-unavailable-or-invalid');
  }
  result.decision = assess(entry, result);
  return result;
}

async function collect(source, request = github) {
  validateSources(source);
  const records = new Array(source.entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < source.entries.length) {
      const index = cursor++;
      records[index] = await collectOne(source.entries[index], request);
    }
  }));
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'), records };
}

function verify(source, evidence) {
  validateSources(source);
  if (evidence?.schemaVersion !== 1 || evidence.sourceSha256 !== createHash('sha256').update(JSON.stringify(source)).digest('hex')) throw new Error('stale inventory evidence');
  if (!Array.isArray(evidence.records) || evidence.records.length !== source.entries.length || !Number.isFinite(Date.parse(evidence.checkedAt))) throw new Error('incomplete evidence');
  evidence.records.forEach((record, index) => {
    if (record.slug !== source.entries[index].slug || record.newSourceFilesImported !== 0) throw new Error('unexpected import claim or inventory order');
    if (record.canonical !== null && !SLUG.test(record.canonical)) throw new Error('invalid canonical slug');
    if (record.commit !== null && !SHA.test(record.commit)) throw new Error('unpinned commit');
    if (record.licenseEvidence) {
      const license = record.licenseEvidence;
      if (!record.canonical || !SHA.test(record.commit || '') || !SHA.test(license.blobSha || '') || !/^[a-f0-9]{64}$/.test(license.sha256 || '') || !Number.isSafeInteger(license.bytes) || license.bytes <= 0 || license.bytes > 1024 * 1024 || !Array.isArray(license.reviewedModulePaths) || license.reviewedModulePaths.length) throw new Error('invalid provenance');
      const expected = `https://github.com/${record.canonical}/blob/${record.commit}/${String(license.path).split('/').map(encodeURIComponent).join('/')}`;
      if (license.url !== expected || String(license.path).split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unpinned license URL');
    }
    if (record.decision !== assess(source.entries[index], record)) throw new Error('invalid license decision');
  });
  return true;
}

function render(source, evidence) {
  verify(source, evidence);
  const cell = value => String(value).replace(/[|\r\n]/g, ' ');
  const rows = source.entries.map((entry, i) => {
    const r = evidence.records[i];
    const origin = r.canonical && r.canonical.toLowerCase() !== entry.slug.toLowerCase() ? `${entry.slug} → ${r.canonical}` : entry.slug;
    const license = r.licenseEvidence ? `[${cell(r.licenseEvidence.spdx)}](${r.licenseEvidence.url})` : 'UNVERIFIED';
    return `| ${cell(origin)} | ${license} | ${r.commit || 'UNRESOLVED'} | ${r.archived === null ? '?' : r.archived} | ${r.decision} | ${cell(entry.intent)} | ${cell(entry.target)} |`;
  });
  return `# Coding V2 — complete source inventory evidence\n\nChecked: ${evidence.checkedAt}. ${rows.length} requested or explicitly resolved repository names, including aliases; **not ${rows.length} distinct integrations**.\n\nThis supplements the policy/catalog work in PR #635 without overwriting another agent's files. All new imports in this inventory are **zero**. Existing historical imports remain documented in THIRD_PARTY_NOTICES.md. A root LICENSE fetched at a commit is automated evidence, not a legal review or permission to copy every module. No claim about archive dates, releases, performance or commercial terms is inferred from the user description.\n\n## Policy\n\nOnly MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0 and PostgreSQL are candidate source licenses. Unknown, compound, restricted and copyleft expressions fail closed for copying; electing an allowed dual license requires a separate review. Operator exclusions win even when GitHub labels a repository permissively. For each adopted slice, review nested licenses and dependencies; retain copyrights plus original LICENSE/NOTICE under third_party/<repo>/; add the exact source pin, files and obligations to THIRD_PARTY_NOTICES.md. MPL-2.0 file-level obligations must be preserved. A package/root SPDX label alone cannot authorize an import. No new providers, secrets, callbacks, UI or production flags are changed here.\n\nThe source list records the requested family and proposed destination, **not an adopted module**. Before a runtime PR: select exact paths, review the pinned original license text and all nested notices, clone the selected source at its pin, then test the adapted slice. Do not bulk-clone blocked or unresolved candidates.\n\n## Reproduce\n\nRun \`node scripts/oss/catalog.cjs verify\` and \`node --test backend/tests/oss-catalog.test.js\`. Research refresh: \`node scripts/oss/catalog.cjs collect\` writes JSON to stdout using an already authenticated GitHub CLI; it performs GET requests only, never installs or executes upstream code, and does not overwrite evidence automatically. Render: \`node scripts/oss/catalog.cjs render\`. Source digest binds the lock to the complete list. License blob SHA-1 and SHA-256 bind fetched license bytes; immutable GitHub URLs allow reviewers to retrieve them again. Full source and recursive NOTICE review remain pending; this inventory is not a clone percentage.\n\n| Requested → canonical | Root license evidence | Commit pin | Archived | Copy decision | Requested use (not imported) | Proposed destination |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## Names without a uniquely supplied repository\n\n${source.unresolvedNames.map(n => `- ${n}: not copied; precise source/terms still required.`).join('\n')}\n\n## Release boundary\n\nThis lot is research tooling only. It neither builds nor deploys Coding V2. Production acceptance still requires a legitimately managed isolated sandbox runtime, private storage, per-session network/CPU/RAM/TTL enforcement, authenticated multiuser tests, accounted model spending and the real Next.js todo-app preview/diff/commit flow. The existing shared runner is not proof of hostile multi-tenant isolation. Keep AGENTES_CODING_V2 off until those gates pass.\n`;
}

if (require.main === module) {
  (async () => {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/oss/sources.json'), 'utf8'));
    const command = process.argv[2];
    if (command === 'collect') return console.log(JSON.stringify(await collect(source), null, 2));
    const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/oss/catalog.lock.json'), 'utf8'));
    if (command === 'verify') { verify(source, evidence); console.log(`${source.entries.length} inventory records verified; no import approval implied`); }
    else if (command === 'render') process.stdout.write(render(source, evidence));
    else throw new Error('usage: catalog.cjs collect|verify|render');
  })().catch(() => { console.error('OSS catalog command failed; inspect local configuration/evidence without sharing secrets.'); process.exitCode = 1; });
}

module.exports = { validateSources, assess, licenseEvidence, collectOne, collect, verify, render };
