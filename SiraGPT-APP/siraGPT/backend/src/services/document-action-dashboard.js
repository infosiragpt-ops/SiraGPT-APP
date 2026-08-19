'use strict';

/**
 * document-action-dashboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregated, priority-ordered actions dashboard. Composes existing
 * deterministic analyzers — does NOT re-implement their extractors:
 *
 *   - document-deep-analyzer        → action sentences, decisions, risks,
 *                                     open questions, candidate claims.
 *   - document-temporal-timeline    → dated events with overdue / upcoming /
 *                                     scheduled / past tags.
 *
 * The output is a single "operations dashboard" block the chat injects so
 * the model can answer "what's pending?", "what needs to ship?", "what's
 * overdue?" without re-scanning the source. Each entry preserves its
 * source file so the model never silently merges two distinct documents.
 *
 * Priority order (top → bottom):
 *   1. OVERDUE deadlines  (date < now + deadline triggers)
 *   2. UPCOMING deadlines (date >= now + deadline triggers)
 *   3. OPEN questions / TBD items
 *   4. ACTION items without dates
 *   5. RISKS & red flags
 *   6. RECENT decisions (signed off / approved / ratified)
 *
 * Bilingual (Spanish / English). Deterministic. No LLM. < 15 ms on a
 * 1 MB document. Resilient — every sub-engine is lazy-required and the
 * module gracefully degrades when one is missing.
 *
 * Public API:
 *   buildDashboardForFiles(files, opts)      → DashboardReport
 *   renderDashboardBlock(report)             → markdown string ('' when empty)
 */

let deepAnalyzerCache = null;
function getDeepAnalyzer() {
  if (deepAnalyzerCache) return deepAnalyzerCache;
  try { deepAnalyzerCache = require('./document-deep-analyzer'); } catch { deepAnalyzerCache = null; }
  return deepAnalyzerCache;
}

let temporalTimelineCache = null;
function getTemporalTimeline() {
  if (temporalTimelineCache) return temporalTimelineCache;
  try { temporalTimelineCache = require('./document-temporal-timeline'); } catch { temporalTimelineCache = null; }
  return temporalTimelineCache;
}

const MAX_PER_BUCKET = 6;
const MAX_BLOCK_CHARS = 4200;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = 220) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Build the dashboard for an array of processed files. Each file is
 * analysed independently then merged into priority-ordered buckets.
 *
 * @param {Array<{ name?: string, originalName?: string, id?: string, extractedText?: string }>} files
 * @param {{ now?: string|Date }} [opts]
 * @returns {DashboardReport}
 */
function buildDashboardForFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const buckets = {
    overdue: [],
    upcoming: [],
    openQuestions: [],
    actionsWithoutDate: [],
    risks: [],
    recentDecisions: [],
  };

  const deepEngine = getDeepAnalyzer();
  const timelineEngine = getTemporalTimeline();

  for (const file of list) {
    const name = safeFileName(file);
    const text = safeText(file.extractedText);
    if (!text) continue;

    // Deadlines + scheduled events come from the timeline engine.
    if (timelineEngine && typeof timelineEngine.extractTimeline === 'function') {
      const tl = timelineEngine.extractTimeline(text, opts);
      for (const event of tl.events) {
        if (event.status === 'overdue-deadline') {
          buckets.overdue.push({
            file: name,
            iso: event.iso,
            sentence: clip(event.sentence),
            kind: 'overdue',
          });
        } else if (event.status === 'upcoming-deadline') {
          buckets.upcoming.push({
            file: name,
            iso: event.iso,
            sentence: clip(event.sentence),
            kind: 'upcoming',
          });
        }
      }
    }

    // Actions / decisions / risks / open questions come from deep-analyzer.
    if (deepEngine && typeof deepEngine.analyzeText === 'function') {
      const deep = deepEngine.analyzeText(text);
      for (const action of deep.actions || []) {
        buckets.actionsWithoutDate.push({
          file: name,
          sentence: clip(action),
          kind: 'action',
        });
      }
      for (const risk of deep.risks || []) {
        buckets.risks.push({
          file: name,
          sentence: clip(risk),
          kind: 'risk',
        });
      }
      for (const q of deep.openQuestions || []) {
        buckets.openQuestions.push({
          file: name,
          sentence: clip(q),
          kind: 'open-question',
        });
      }
      for (const d of deep.decisions || []) {
        buckets.recentDecisions.push({
          file: name,
          sentence: clip(d),
          kind: 'decision',
        });
      }
    }
  }

  // Sort and dedupe each bucket.
  buckets.overdue = dedupeBy(buckets.overdue, (e) => `${e.file}|${e.sentence}`).sort((a, b) => a.iso.localeCompare(b.iso));
  buckets.upcoming = dedupeBy(buckets.upcoming, (e) => `${e.file}|${e.sentence}`).sort((a, b) => a.iso.localeCompare(b.iso));
  buckets.openQuestions = dedupeBy(buckets.openQuestions, (e) => `${e.file}|${e.sentence}`);
  buckets.actionsWithoutDate = dedupeBy(buckets.actionsWithoutDate, (e) => `${e.file}|${e.sentence}`);
  buckets.risks = dedupeBy(buckets.risks, (e) => `${e.file}|${e.sentence}`);
  buckets.recentDecisions = dedupeBy(buckets.recentDecisions, (e) => `${e.file}|${e.sentence}`);

  // Trim actions: drop any whose sentence text already shows up in the
  // overdue/upcoming bucket — those are already represented as deadlines
  // and the dashboard shouldn't double-count them.
  const datedSentences = new Set();
  for (const e of buckets.overdue) datedSentences.add(`${e.file}|${e.sentence}`);
  for (const e of buckets.upcoming) datedSentences.add(`${e.file}|${e.sentence}`);
  buckets.actionsWithoutDate = buckets.actionsWithoutDate.filter((a) => !datedSentences.has(`${a.file}|${a.sentence}`));

  // Apply per-bucket caps (sorted/deduped lists keep their priority order).
  for (const key of Object.keys(buckets)) {
    buckets[key] = buckets[key].slice(0, MAX_PER_BUCKET);
  }

  const totals = {
    overdue: buckets.overdue.length,
    upcoming: buckets.upcoming.length,
    openQuestions: buckets.openQuestions.length,
    actionsWithoutDate: buckets.actionsWithoutDate.length,
    risks: buckets.risks.length,
    recentDecisions: buckets.recentDecisions.length,
  };
  const total = Object.values(totals).reduce((acc, n) => acc + n, 0);

  return {
    buckets,
    totals,
    total,
    fileCount: list.length,
  };
}

function renderBucket(title, entries, kind, opts = {}) {
  if (!entries || entries.length === 0) return '';
  const lines = [`### ${title}`];
  if (opts.hint) lines.push(`_${opts.hint}_`);
  for (const e of entries) {
    const head = e.iso
      ? `**${e.iso}** · _${e.file}_ — ${e.sentence}`
      : `_${e.file}_ — ${e.sentence}`;
    lines.push(`- ${head}`);
  }
  return lines.join('\n');
}

function renderDashboardBlock(report) {
  if (!report || !report.total || report.total === 0) return '';
  const heading = `## OPERATIONS DASHBOARD
Priority-ordered list of overdue deadlines, upcoming deadlines, open questions, dateless action items, risks, and recent decisions surfaced across the attached document(s). Treat as a working punch list — quote the source sentence verbatim before claiming a deadline is firm. Each entry keeps its source file so cross-document items don't get silently merged.`;

  const sections = [
    renderBucket('Overdue deadlines', report.buckets.overdue, 'overdue', {
      hint: 'Past dates paired with deadline / vence / due-by language. Surface first when answering "what\'s late?".',
    }),
    renderBucket('Upcoming deadlines', report.buckets.upcoming, 'upcoming', {
      hint: 'Future dates paired with deadline language. Surface when the user asks "what\'s next?".',
    }),
    renderBucket('Open questions / TBD', report.buckets.openQuestions, 'open-question', {
      hint: 'Items the document marks as unresolved. Treat as gaps — don\'t answer past them.',
    }),
    renderBucket('Action items (no fixed date)', report.buckets.actionsWithoutDate, 'action', {
      hint: 'Imperative / deliverable sentences without an explicit deadline. Candidate TODOs.',
    }),
    renderBucket('Risks & red flags', report.buckets.risks, 'risk'),
    renderBucket('Recent decisions', report.buckets.recentDecisions, 'decision', {
      hint: 'Statements the document presents as resolved. Do not re-litigate without new evidence.',
    }),
  ].filter(Boolean);

  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...operations dashboard truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildDashboardForFiles,
  renderDashboardBlock,
  _internal: {
    dedupeBy,
    safeFileName,
    MAX_PER_BUCKET,
    MAX_BLOCK_CHARS,
  },
};
