'use strict';

/**
 * Supernode builder — clusters atomic features into higher-level concepts.
 *
 * Anthropic's attribution-graphs paper groups related features into
 * "supernodes" (e.g. all features representing "Texas" cluster into one
 * Texas supernode). We do the analogous thing for user intent: turn a
 * scatter of action/object/modifier features into a small set of named
 * higher-level intent clusters that a downstream LLM can reason about.
 *
 * Each supernode has:
 *   - id, label, theme (e.g. "build-software", "analyze-document")
 *   - members (feature ids)
 *   - centroidEvidence (short text)
 *   - aggregateWeight (sum of member weights, clamped)
 *   - aggregateConfidence (weighted avg confidence)
 */

const { FEATURE_CATEGORIES } = require('./feature-extractor');

const THEMES = [
  {
    id: 'build-software',
    label: 'Build / extend software',
    when: ({ actionLabels, objectLabels }) =>
      (actionLabels.has('create') || actionLabels.has('modify')) &&
      (objectLabels.has('code-artifact') || objectLabels.has('api-surface') ||
       objectLabels.has('feature') || objectLabels.has('system')),
  },
  {
    id: 'fix-defect',
    label: 'Fix bug or regression',
    when: ({ actionLabels, objectLabels }) =>
      (actionLabels.has('modify') || actionLabels.has('analyze')) && objectLabels.has('defect'),
  },
  {
    id: 'analyze-document',
    label: 'Analyze a document or dataset',
    when: ({ actionLabels, objectLabels }) =>
      actionLabels.has('analyze') &&
      (objectLabels.has('document') || objectLabels.has('file-format') || objectLabels.has('memory-context')),
  },
  {
    id: 'generate-visual',
    label: 'Generate visual content',
    when: ({ actionLabels, objectLabels }) =>
      (actionLabels.has('create') || actionLabels.has('summarize')) &&
      (objectLabels.has('visualization') || objectLabels.has('media-asset')),
  },
  {
    id: 'deploy-or-run',
    label: 'Deploy / run something',
    when: ({ actionLabels, objectLabels }) =>
      actionLabels.has('execute') && (objectLabels.has('deployment') || objectLabels.has('system') || objectLabels.has('api-surface')),
  },
  {
    id: 'research-or-search',
    label: 'Research / search / look up',
    when: ({ actionLabels, objectLabels }) =>
      actionLabels.has('search') || actionLabels.has('explain') ||
      (actionLabels.has('analyze') && !objectLabels.has('defect')),
  },
  {
    id: 'verify-quality',
    label: 'Test / verify / validate',
    when: ({ actionLabels, objectLabels }) =>
      actionLabels.has('verify') || objectLabels.has('test-suite'),
  },
  {
    id: 'security-hardening',
    label: 'Security & hardening',
    when: ({ objectLabels }) => objectLabels.has('security'),
  },
  {
    id: 'performance-optimization',
    label: 'Performance optimization',
    when: ({ actionLabels, objectLabels }) =>
      objectLabels.has('performance') ||
      (actionLabels.has('modify') && objectLabels.has('system')),
  },
  {
    id: 'collaborate-content',
    label: 'Write / draft content',
    when: ({ actionLabels, objectLabels }) =>
      actionLabels.has('create') && (objectLabels.has('document') || !objectLabels.size),
  },
  {
    id: 'translate-content',
    label: 'Translate or localize',
    when: ({ actionLabels }) => actionLabels.has('translate'),
  },
  {
    id: 'continue-prior-work',
    label: 'Continue prior task',
    when: ({ actionLabels }) => actionLabels.has('continue'),
  },
  {
    id: 'compare-options',
    label: 'Compare options or alternatives',
    when: ({ actionLabels }) => actionLabels.has('compare'),
  },
  {
    id: 'help-debug',
    label: 'Get help / clarification',
    when: ({ actionLabels }) =>
      actionLabels.has('help') || actionLabels.has('explain'),
  },
  {
    id: 'remove-or-cleanup',
    label: 'Remove or clean up',
    when: ({ actionLabels }) => actionLabels.has('remove'),
  },
];

function summarizeMembers(members) {
  return members
    .map((m) => m.evidence || m.label)
    .filter(Boolean)
    .slice(0, 5)
    .join(' · ');
}

function buildSupernodes(graph) {
  if (!graph?.nodes?.length) return { supernodes: [], unassigned: [] };

  const realNodes = graph.nodes.filter((n) => !n.synthetic);
  const actions = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.ACTION);
  const objects = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.OBJECT);
  const modifiers = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.MODIFIER);
  const constraints = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.CONSTRAINT);
  const implicits = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.IMPLICIT);
  const tones = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.TONE);
  const personas = realNodes.filter((n) => n.category === FEATURE_CATEGORIES.PERSONA);

  const actionLabels = new Set(actions.map((a) => a.label));
  const objectLabels = new Set(objects.map((o) => o.label));

  const supernodes = [];
  const assignedIds = new Set();

  for (const theme of THEMES) {
    if (!theme.when({ actionLabels, objectLabels })) continue;

    // members = matching actions, matching objects, plus all attached modifiers/constraints/implicits
    const members = [];
    for (const a of actions) {
      if (a.label && actionLabels.has(a.label)) members.push(a);
    }
    for (const o of objects) {
      if (o.label && objectLabels.has(o.label)) members.push(o);
    }
    // attach modifiers/constraints/implicits if at least one edge connects them to a member
    const memberIds = new Set(members.map((m) => m.id));
    for (const m of modifiers) {
      if (graph.edges.some((e) => e.source === m.id && memberIds.has(e.target))) {
        members.push(m);
      }
    }
    for (const c of constraints) {
      if (graph.edges.some((e) => e.source === c.id && memberIds.has(e.target))) {
        members.push(c);
      }
    }
    for (const imp of implicits) {
      if (graph.edges.some((e) => e.target === imp.id && memberIds.has(e.source))) {
        members.push(imp);
      }
    }

    if (!members.length) continue;

    const aggregateWeight = Math.min(1, members.reduce((acc, m) => acc + (m.weight || 0), 0) / Math.max(2, members.length / 2));
    const confSum = members.reduce((acc, m) => acc + (m.weight * m.confidence || 0), 0);
    const wSum = members.reduce((acc, m) => acc + (m.weight || 0), 0);
    const aggregateConfidence = wSum > 0 ? +(confSum / wSum).toFixed(3) : 0.5;

    supernodes.push({
      id: `super:${theme.id}`,
      themeId: theme.id,
      label: theme.label,
      members: [...new Set(members.map((m) => m.id))],
      memberCount: new Set(members.map((m) => m.id)).size,
      centroidEvidence: summarizeMembers(members),
      aggregateWeight: +aggregateWeight.toFixed(3),
      aggregateConfidence,
    });
    for (const m of members) assignedIds.add(m.id);
  }

  // Stylistic supernode (tone + persona + language)
  const styleMembers = [...tones, ...personas];
  if (styleMembers.length) {
    supernodes.push({
      id: 'super:style',
      themeId: 'style',
      label: 'Output style & voice',
      members: styleMembers.map((m) => m.id),
      memberCount: styleMembers.length,
      centroidEvidence: summarizeMembers(styleMembers),
      aggregateWeight: Math.min(1, styleMembers.reduce((acc, m) => acc + m.weight, 0) / Math.max(2, styleMembers.length)),
      aggregateConfidence: 0.7,
    });
    for (const m of styleMembers) assignedIds.add(m.id);
  }

  // Rank supernodes by aggregate weight × confidence
  supernodes.sort((a, b) => (b.aggregateWeight * b.aggregateConfidence) - (a.aggregateWeight * a.aggregateConfidence));

  const unassigned = realNodes.filter((n) => !assignedIds.has(n.id) && n.category !== FEATURE_CATEGORIES.NEGATION);

  return { supernodes, unassigned };
}

module.exports = { buildSupernodes, THEMES };
