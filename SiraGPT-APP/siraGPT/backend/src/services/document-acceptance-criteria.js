'use strict';

/**
 * document-acceptance-criteria.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects acceptance criteria sections used in user stories / tickets /
 * PRDs, including Gherkin-style blocks (Given / When / Then / And / But)
 * and labelled "Acceptance Criteria:" bullets.
 *
 * Output groups each scenario by its triggering "Scenario:" / numbered
 * header, lists the steps with keyword type, and identifies labelled
 * AC bullets as standalone items.
 *
 * Different from document-checklists (markdown checkboxes), document-
 * obligations (must / should language), and document-conditional-clauses
 * (if / unless prose). Routes "what are the acceptance criteria?",
 * "what are the test scenarios?" to a citeable structure.
 *
 * Public API:
 *   extractAcceptanceCriteria(text)         → ACReport
 *   buildAcceptanceCriteriaForFiles(files)  → { perFile, aggregate, totals }
 *   renderAcceptanceCriteriaBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_SCENARIOS_PER_FILE = 8;
const MAX_STEPS_PER_SCENARIO = 16;
const MAX_AC_BULLETS_PER_FILE = 16;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 6000;
const MAX_TEXT_LEN = 220;

const SCENARIO_HEADER_RE = /^\s*(?:Scenario|Scenario\s+Outline|Background|Escenario|Caso\s+de\s+uso)\s*[:\-—]\s*([^\n]+)$/gim;
const GHERKIN_STEP_RE = /^\s*(Given|When|Then|And|But|Dado|Cuando|Entonces|Y|Pero)\b\s+([^\n]+)$/gim;
const AC_SECTION_HEADER_RE = /^[\t ]*(?:#{1,6}\s+)?(?:Acceptance\s+Criteria|AC|Acceptance\s+Tests|Criterios\s+de\s+Aceptaci[óo]n|CA)\s*[:.]?\s*$/gim;
const NUMBERED_BULLET_RE = /^[\t ]*(?:[-*+]|\d+[.)])\s+([^\n]+)$/gim;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const trimmed = String(s || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_TEXT_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_TEXT_LEN - 1)}…`;
}

function normaliseKeyword(kw) {
  const k = (kw || '').toLowerCase();
  if (k === 'given' || k === 'dado') return 'Given';
  if (k === 'when' || k === 'cuando') return 'When';
  if (k === 'then' || k === 'entonces') return 'Then';
  if (k === 'and' || k === 'y') return 'And';
  if (k === 'but' || k === 'pero') return 'But';
  return kw;
}

function extractAcceptanceCriteria(input) {
  const text = safeText(input);
  if (!text) return { scenarios: [], acBullets: [], total: 0, totals: { scenarios: 0, acBullets: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const lines = head.split('\n');

  const scenarios = [];
  const acBullets = [];

  // Scenario detection pass — collect Scenario: lines + their following Gherkin steps
  let currentScenario = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (scenarios.length >= MAX_SCENARIOS_PER_FILE && !currentScenario) {
      break;
    }
    const scHeader = /^\s*(?:Scenario|Scenario\s+Outline|Background|Escenario|Caso\s+de\s+uso)\s*[:\-—]\s*([^\n]+)$/i.exec(line);
    if (scHeader) {
      if (currentScenario && currentScenario.steps.length > 0 && scenarios.length < MAX_SCENARIOS_PER_FILE) scenarios.push(currentScenario);
      currentScenario = { title: clipText(scHeader[1]), steps: [] };
      continue;
    }
    const stepMatch = /^\s*(Given|When|Then|And|But|Dado|Cuando|Entonces|Y|Pero)\b\s+([^\n]+)$/i.exec(line);
    if (stepMatch) {
      if (!currentScenario) {
        currentScenario = { title: '(unnamed scenario)', steps: [] };
      }
      if (currentScenario.steps.length < MAX_STEPS_PER_SCENARIO) {
        currentScenario.steps.push({
          keyword: normaliseKeyword(stepMatch[1]),
          text: clipText(stepMatch[2]),
        });
      }
      continue;
    }
    // Blank or non-step line → finalise scenario if we have steps
    if (currentScenario && currentScenario.steps.length > 0 && /^\s*$/.test(line)) {
      if (scenarios.length < MAX_SCENARIOS_PER_FILE) scenarios.push(currentScenario);
      currentScenario = null;
    }
  }
  if (currentScenario && currentScenario.steps.length > 0 && scenarios.length < MAX_SCENARIOS_PER_FILE) {
    scenarios.push(currentScenario);
  }

  // AC bullet detection pass — look for "Acceptance Criteria" header + following bullets
  AC_SECTION_HEADER_RE.lastIndex = 0;
  for (const m of head.matchAll(AC_SECTION_HEADER_RE)) {
    const startIdx = m.index + m[0].length;
    const remaining = head.slice(startIdx, startIdx + 4000);
    const sectionLines = remaining.split('\n');
    for (const line of sectionLines) {
      if (acBullets.length >= MAX_AC_BULLETS_PER_FILE) break;
      const trimmed = line.trim();
      if (/^#/.test(trimmed)) break; // next heading
      if (trimmed === '') {
        // Allow up to one blank line before terminating
        continue;
      }
      const bm = /^[\t ]*(?:[-*+]|\d+[.)])\s+([^\n]+)$/.exec(line);
      if (bm) {
        const t = clipText(bm[1]);
        if (t && !acBullets.some((a) => a.text === t)) acBullets.push({ text: t });
      } else if (!bm && trimmed.length > 0 && acBullets.length === 0) {
        // First non-bullet content terminates the AC section
        break;
      }
    }
  }

  const totals = { scenarios: scenarios.length, acBullets: acBullets.length };
  const total = totals.scenarios + totals.acBullets;
  return { scenarios, acBullets, total, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildAcceptanceCriteriaForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { scenarios: 0, acBullets: 0 };
  for (const f of list) {
    const r = extractAcceptanceCriteria(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, scenarios: r.scenarios, acBullets: r.acBullets, totals: r.totals });
    aggregate = aggregate.concat(r.scenarios.map((s) => ({ kind: 'scenario', file: name, title: s.title, steps: s.steps })));
    aggregate = aggregate.concat(r.acBullets.map((b) => ({ kind: 'bullet', file: name, text: b.text })));
    totals.scenarios += r.totals.scenarios;
    totals.acBullets += r.totals.acBullets;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderScenario(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  const lines = [`**Scenario: ${s.title}**${file}`];
  for (const step of s.steps) lines.push(`- _${step.keyword}_ ${step.text}`);
  return lines.join('\n');
}

function renderBullet(b, opts = {}) {
  const file = opts.includeFile && b.file ? ` _(${b.file})_` : '';
  return `- ${b.text}${file}`;
}

function renderAcceptanceCriteriaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const t = report.totals || { scenarios: 0, acBullets: 0 };
  const heading = `## ACCEPTANCE CRITERIA
Gherkin scenarios (Scenario / Background / Escenario / Caso de uso) with Given–When–Then steps (Dado–Cuando–Entonces in Spanish) plus labelled "Acceptance Criteria:" bullet lists. Different from generic checklists (markdown checkboxes) by focusing on requirement-validation phrasing. Routes "what are the acceptance criteria?", "what are the test scenarios?" to a citeable structure.

**Totals:** scenarios=${t.scenarios}  acBullets=${t.acBullets}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.scenarios) sections.push(renderScenario(s));
    if (only.acBullets.length > 0) {
      sections.push('**Labelled Acceptance Criteria:**');
      for (const b of only.acBullets) sections.push(renderBullet(b));
    }
  } else {
    sections.push('### Aggregate AC across all files');
    for (const a of report.aggregate) {
      if (a.kind === 'scenario') sections.push(renderScenario(a, { includeFile: true }));
      else sections.push(renderBullet(a, { includeFile: true }));
    }
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.scenarios) sections.push(renderScenario(s));
      if (p.acBullets.length > 0) {
        sections.push('**Labelled Acceptance Criteria:**');
        for (const b of p.acBullets) sections.push(renderBullet(b));
      }
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...AC block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractAcceptanceCriteria,
  buildAcceptanceCriteriaForFiles,
  renderAcceptanceCriteriaBlock,
  _internal: {
    SCENARIO_HEADER_RE,
    GHERKIN_STEP_RE,
    AC_SECTION_HEADER_RE,
    NUMBERED_BULLET_RE,
    normaliseKeyword,
  },
};
