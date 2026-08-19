'use strict';

/**
 * document-maven-coords.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Maven / Gradle coordinates:
 *
 *   - GAV string:   groupId:artifactId:version
 *   - GAVTC:        groupId:artifactId:version:type:classifier
 *   - pom.xml dependency: <groupId>x</groupId><artifactId>y</artifactId><version>z</version>
 *   - Gradle:       implementation 'group:artifact:1.0'  /  group: "x", name: "y", version: "z"
 *   - Maven Central URL: repo1.maven.org/maven2/<path>
 *
 * Public API:
 *   extractMavenCoords(text)             → { entries, totals, total }
 *   buildMavenCoordsForFiles(files)      → { perFile, aggregate, totals }
 *   renderMavenCoordsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const GAV_RE = /\b([a-z][a-z0-9_.-]{2,80})\.([a-z][a-z0-9_-]{0,40}):([a-z0-9][a-z0-9_.-]{1,80}):(\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?)\b/g;
const POM_RE = /<groupId>([a-z0-9._-]{1,100})<\/groupId>\s*<artifactId>([a-z0-9._-]{1,80})<\/artifactId>\s*<version>([0-9][0-9a-zA-Z._-]{0,40})<\/version>/g;
const GRADLE_STRING_RE = /(?:implementation|api|testImplementation|compileOnly|runtimeOnly|annotationProcessor)\s+['"]([a-z0-9._-]{2,100}):([a-z0-9._-]{1,80}):([0-9][0-9a-zA-Z._-]{1,40})['"]/g;
const GRADLE_MAP_RE = /\bgroup\s*[:=]\s*['"]([a-z0-9._-]{2,100})['"]\s*,\s*name\s*[:=]\s*['"]([a-z0-9._-]{1,80})['"]\s*,\s*version\s*[:=]\s*['"]([0-9][0-9a-zA-Z._-]{1,40})['"]/g;
const MAVEN_URL_RE = /\brepo1\.maven\.org\/maven2\/([A-Za-z0-9._/-]{10,250})/g;

function extractMavenCoords(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { gav: 0, pom: 0, gradle: 0, mavenUrl: 0 };

  function push(kind, groupId, artifactId, version) {
    const gav = `${groupId}:${artifactId}:${version}`;
    if (seen.has(gav)) return;
    seen.add(gav);
    entries.push({ kind, groupId, artifactId, version, gav });
    if (totals[kind] != null) totals[kind] += 1;
  }

  POM_RE.lastIndex = 0;
  let m;
  while ((m = POM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('pom', m[1], m[2], m[3]);
  }
  if (entries.length < MAX_PER_FILE) {
    GRADLE_STRING_RE.lastIndex = 0;
    while ((m = GRADLE_STRING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gradle', m[1], m[2], m[3]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GRADLE_MAP_RE.lastIndex = 0;
    while ((m = GRADLE_MAP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gradle', m[1], m[2], m[3]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GAV_RE.lastIndex = 0;
    while ((m = GAV_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gav', `${m[1]}.${m[2]}`, m[3], m[4]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MAVEN_URL_RE.lastIndex = 0;
    while ((m = MAVEN_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `mavenUrl:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'mavenUrl', groupId: null, artifactId: null, version: null, gav: m[1].slice(0, 100) });
      totals.mavenUrl += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMavenCoordsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { gav: 0, pom: 0, gradle: 0, mavenUrl: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMavenCoords(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.gav)) continue;
      aggSeen.add(e.gav);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderMavenCoordsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MAVEN / GRADLE COORDINATES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] \`${e.gav}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMavenCoords,
  buildMavenCoordsForFiles,
  renderMavenCoordsBlock,
};
