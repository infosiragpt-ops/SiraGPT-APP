'use strict';

/**
 * Prompt formatter — renders an attribution-graph report into a compact
 * system-prompt block ready to inject into an LLM call.
 *
 * The goal is *high signal per token*: a model that knows the user's
 * explicit features, implicit needs, likely next steps and confidence
 * level can plan a much better response than one staring at raw text.
 *
 * Hard cap on output size (configurable env: SIRAGPT_INTENT_ATTR_BLOCK_MAX_CHARS,
 * default 3500). Truncation is greedy — drop optional sections first.
 */

const DEFAULT_MAX_CHARS = Number.parseInt(process.env.SIRAGPT_INTENT_ATTR_BLOCK_MAX_CHARS || '3500', 10);

function bullets(items, render, max = 6) {
  if (!items || !items.length) return '';
  return items.slice(0, max).map((x) => `- ${render(x)}`).join('\n');
}

function renderSupernode(sn) {
  const w = Math.round(sn.aggregateWeight * 100);
  const c = Math.round(sn.aggregateConfidence * 100);
  return `**${sn.label}** (weight ${w}%, confidence ${c}%) — ${sn.centroidEvidence}`;
}

function renderCircuit(c) {
  return `${c.description} _[score ${c.score}]_`;
}

function renderPrereq(p) {
  return `${p.requirement}. _Why: ${p.rationale}_`;
}

function renderNext(n) {
  return `${n.prediction} (${Math.round(n.likelihood * 100)}% likely)`;
}

function renderHidden(h) {
  return `**[${h.type}]** Surface: ${h.surface}. Hidden: ${h.hidden}. → ${h.strategy}`;
}

function renderAmbiguity(a) {
  return `**[${a.severity}]** ${a.issue} _Ask:_ "${a.question}"`;
}

function formatBlock(report, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  if (!report) return '';

  const lines = [];
  lines.push('## USER INTENT ATTRIBUTION GRAPH');
  lines.push('_(Auto-generated decomposition of the user\'s request into atomic features, themes, multi-step circuits, anticipated next steps, hidden intent, and a calibrated confidence score. Use this to plan a better response.)_');
  lines.push('');

  // 1. Confidence band (always first — tells the model how much to trust the rest)
  if (report.confidence) {
    const c = report.confidence;
    lines.push(`### Confidence: **${c.band}** (${Math.round(c.score * 100)}%)`);
    lines.push(c.bandText);
    if (c.shouldAskClarification) {
      lines.push('> ⚠️ At least one **high-severity** ambiguity detected — strongly consider asking a clarifying question before acting.');
    }
    lines.push('');
  }

  // 2. Top supernodes (themes)
  if (report.supernodes?.length) {
    lines.push('### Top intent themes');
    lines.push(bullets(report.supernodes, renderSupernode, 4));
    lines.push('');
  }

  // 3. Multi-step circuits (the implied reasoning chain)
  if (report.circuits?.length) {
    lines.push('### Implied reasoning circuits');
    lines.push(bullets(report.circuits, renderCircuit, 6));
    lines.push('');
  }

  // 4. Prerequisites
  if (report.plan?.prerequisites?.length) {
    lines.push('### Prerequisites (do these *before* responding)');
    lines.push(bullets(report.plan.prerequisites, renderPrereq, 6));
    lines.push('');
  }

  // 5. Hidden intents
  if (report.hiddenIntents?.length) {
    lines.push('### Hidden intents (surface vs. real)');
    lines.push(bullets(report.hiddenIntents, renderHidden, 4));
    lines.push('');
  }

  // 6. Anticipated next steps
  if (report.plan?.nextSteps?.length) {
    lines.push('### Anticipated next steps (plan ahead)');
    lines.push(bullets(report.plan.nextSteps, renderNext, 5));
    lines.push('');
  }

  // 7. Ambiguities (drilled-in clarifying questions)
  if (report.confidence?.ambiguities?.length) {
    lines.push('### Ambiguities to consider');
    lines.push(bullets(report.confidence.ambiguities, renderAmbiguity, 4));
    lines.push('');
  }

  // 8. Compact stats
  if (report.stats) {
    const s = report.stats;
    lines.push(`### Stats — ${s.featureCount} features · ${s.supernodeCount} themes · ${s.circuitCount} circuits · ${s.edgeCount} edges · language: ${s.language}`);
    lines.push('');
  }

  // 9. Final directive
  lines.push('> **How to use this:** prioritize themes by weight, satisfy prerequisites first, answer the surface request *and* address the hidden intent, and proactively cover the top anticipated next step in your reply if it\'s cheap to do so. If confidence is medium-low or lower with a high-severity ambiguity, ask a single targeted clarifying question rather than guessing.');

  let block = lines.join('\n');
  if (block.length > maxChars) {
    // Greedy truncation: drop sections from the bottom upwards (keeping confidence + themes always)
    const sections = block.split(/\n(?=### )/);
    while (sections.length > 3 && sections.join('\n').length > maxChars) {
      // Drop second-to-last so we keep the final directive
      sections.splice(sections.length - 2, 1);
    }
    block = sections.join('\n');
    if (block.length > maxChars) {
      block = `${block.slice(0, maxChars - 24).trimEnd()}\n…(truncated)`;
    }
  }
  return block;
}

function formatCompactSummary(report) {
  if (!report) return '';
  const parts = [];
  if (report.supernodes?.length) {
    parts.push(`themes: ${report.supernodes.slice(0, 3).map((s) => s.label).join(' · ')}`);
  }
  if (report.confidence) {
    parts.push(`confidence: ${report.confidence.band} (${Math.round(report.confidence.score * 100)}%)`);
  }
  if (report.plan?.prerequisites?.length) {
    parts.push(`prereqs: ${report.plan.prerequisites.length}`);
  }
  if (report.hiddenIntents?.length) {
    parts.push(`hidden: ${report.hiddenIntents.length}`);
  }
  return parts.join(' | ');
}

module.exports = { formatBlock, formatCompactSummary, DEFAULT_MAX_CHARS };
