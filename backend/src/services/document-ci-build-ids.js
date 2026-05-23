'use strict';

/**
 * document-ci-build-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects CI / CD build identifiers across providers:
 *
 *   - GitHub Actions:  /actions/runs/12345678 | run ID 12345678 | workflow run #42
 *   - Jenkins:         build #123 | jobs/foo/builds/42
 *   - CircleCI:        workflow xxxx-yyyy | https://circleci.com/.../12345
 *   - GitLab CI:       pipeline #12345 | -/pipelines/12345
 *   - Travis:          build #123 (with travis-ci.com domain)
 *   - Buildkite:       buildkite.com/org/pipeline/builds/123
 *
 * Public API:
 *   extractCiBuildIds(text)             → { entries, totals, total }
 *   buildCiBuildIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderCiBuildIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const GHA_RUNS_RE = /\bactions\/runs\/(\d{6,15})/g;
const GHA_LABELED_RE = /\b(?:workflow\s+run|GitHub\s+Actions\s+run)[#\s:]+(\d{6,15})/gi;
const JENKINS_BUILD_RE = /\b(?:jenkins|build)\s+#(\d{1,6})\b/gi;
const JENKINS_PATH_RE = /\/jobs?\/([A-Za-z0-9_-]{2,80})\/builds\/(\d{1,6})/g;
const CIRCLECI_URL_RE = /\bhttps?:\/\/(?:app\.|www\.)?circleci\.com\/[^\s]*?(?:workflow-runs?|workflows|jobs)\/([0-9a-f-]{8,40})/gi;
const GITLAB_PIPELINE_RE = /\b(?:pipeline)\s+#(\d{4,12})\b/gi;
const GITLAB_URL_RE = /\/-\/pipelines\/(\d{4,12})/g;
const BUILDKITE_URL_RE = /\bbuildkite\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/builds\/(\d{1,8})/g;
const AZURE_BUILD_RE = /\b(?:azure\s+pipelines|build)\s+ID[\s:#]+(\d{4,10})\b/gi;

function extractCiBuildIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { gha: 0, jenkins: 0, circleci: 0, gitlab: 0, buildkite: 0, azure: 0 };

  function push(provider, id, ctx) {
    const key = `${provider}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ provider, id, context: ctx });
    if (totals[provider] != null) totals[provider] += 1;
  }

  // GHA
  GHA_RUNS_RE.lastIndex = 0;
  let m;
  while ((m = GHA_RUNS_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gha', m[1], 'actions/runs');
  GHA_LABELED_RE.lastIndex = 0;
  while ((m = GHA_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gha', m[1], 'labeled');

  // Jenkins
  if (entries.length < MAX_PER_FILE) {
    JENKINS_BUILD_RE.lastIndex = 0;
    while ((m = JENKINS_BUILD_RE.exec(body)) && entries.length < MAX_PER_FILE) push('jenkins', m[1], 'build-#');
    JENKINS_PATH_RE.lastIndex = 0;
    while ((m = JENKINS_PATH_RE.exec(body)) && entries.length < MAX_PER_FILE) push('jenkins', `${m[1]}/${m[2]}`, 'jobs-path');
  }

  // CircleCI
  if (entries.length < MAX_PER_FILE) {
    CIRCLECI_URL_RE.lastIndex = 0;
    while ((m = CIRCLECI_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('circleci', m[1], 'url');
  }

  // GitLab
  if (entries.length < MAX_PER_FILE) {
    GITLAB_PIPELINE_RE.lastIndex = 0;
    while ((m = GITLAB_PIPELINE_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gitlab', m[1], 'pipeline-#');
    GITLAB_URL_RE.lastIndex = 0;
    while ((m = GITLAB_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gitlab', m[1], '/-/pipelines');
  }

  // Buildkite
  if (entries.length < MAX_PER_FILE) {
    BUILDKITE_URL_RE.lastIndex = 0;
    while ((m = BUILDKITE_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('buildkite', `${m[1]}/${m[2]}/${m[3]}`, 'url');
  }

  // Azure
  if (entries.length < MAX_PER_FILE) {
    AZURE_BUILD_RE.lastIndex = 0;
    while ((m = AZURE_BUILD_RE.exec(body)) && entries.length < MAX_PER_FILE) push('azure', m[1], 'labeled');
  }

  return { entries, totals, total: entries.length };
}

function buildCiBuildIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { gha: 0, jenkins: 0, circleci: 0, gitlab: 0, buildkite: 0, azure: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCiBuildIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.provider}:${e.id}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCiBuildIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CI / CD BUILD IDs'];
  const t = report.totals || {};
  const parts = [];
  if (t.gha) parts.push(`GHA: ${t.gha}`);
  if (t.jenkins) parts.push(`Jenkins: ${t.jenkins}`);
  if (t.circleci) parts.push(`CircleCI: ${t.circleci}`);
  if (t.gitlab) parts.push(`GitLab: ${t.gitlab}`);
  if (t.buildkite) parts.push(`Buildkite: ${t.buildkite}`);
  if (t.azure) parts.push(`Azure: ${t.azure}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.provider}: \`${e.id}\` (${e.context})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCiBuildIds,
  buildCiBuildIdsForFiles,
  renderCiBuildIdsBlock,
};
