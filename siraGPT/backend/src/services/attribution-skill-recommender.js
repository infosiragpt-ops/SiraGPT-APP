'use strict';

/**
 * attribution-skill-recommender.js
 *
 * Given the attribution-engine bundle (intents + entities + concepts +
 * supernodes), recommends which existing siraGPT skill / API route
 * should be invoked. Bridges the attribution stack to the skills
 * registry without depending on the skills-registry module (so the
 * recommender works even when the registry isn't loaded).
 *
 * Each recommendation:
 *   { skill, confidence, rationale, params?, alternatives[] }
 *
 * Static catalogue covers the most-used siraGPT capabilities. The
 * caller can pass `additionalSkills` to extend the catalogue at runtime.
 *
 * Pure heuristic, no LLM.
 */

const conceptExtractor = require('./concept-extractor');
const conceptSim = require('./concept-similarity');

// Each entry: triggers (intent + concept canonicals + cue regex), skill id,
// rationale template, optional param hints.
const SKILL_CATALOGUE = [
  {
    id: 'document_pipeline.generate_pdf',
    triggers: { intents: ['create', 'document'], supernodes: ['document'], cues: [/\b(pdf|reporte|informe|whitepaper|report)\b/i] },
    rationale: 'Detected request to generate a PDF / formal report.',
    params: { format: 'pdf' },
  },
  {
    id: 'document_pipeline.generate_xlsx',
    triggers: { intents: ['create'], cues: [/\b(excel|xlsx|hoja\s+de\s+c[aá]lculo|spreadsheet)\b/i] },
    rationale: 'Detected request to generate an XLSX spreadsheet.',
    params: { format: 'xlsx' },
  },
  {
    id: 'document_pipeline.generate_pptx',
    triggers: { intents: ['create'], cues: [/\b(presentaci[oó]n|slides|deck|pptx|powerpoint)\b/i] },
    rationale: 'Detected request to generate a presentation deck.',
    params: { format: 'pptx' },
  },
  {
    id: 'visual_media.create_chart',
    triggers: { cues: [/\b(gr[aá]fico|chart|gr[aá]fica|barras|l[ií]nea|funnel|gauge|heatmap|treemap|waterfall)\b/i] },
    rationale: 'Detected request to render a chart/visualization.',
  },
  {
    id: 'visual_media.create_mermaid_diagram',
    triggers: { cues: [/\b(diagrama|flowchart|sequence|mermaid|er\s+diagram|state\s+machine)\b/i] },
    rationale: 'Detected request to render a Mermaid diagram.',
  },
  {
    id: 'agent.task',
    triggers: { intents: ['fix', 'modify', 'create', 'deploy'], supernodes: ['code', 'backend', 'ui'] },
    rationale: 'Software-engineering task — route through the agent task runner.',
  },
  {
    id: 'research_agent.run',
    triggers: { intents: ['search', 'analyze'], cues: [/\b(investiga|research|paper|estudio|scientific|cita\s+art[ií]culos)\b/i] },
    rationale: 'Open-ended research request — route through the research agent.',
  },
  {
    id: 'scientific_search',
    triggers: { intents: ['search'], cues: [/\b(arxiv|pubmed|crossref|semantic\s+scholar|paper|preprint|publicaci[oó]n cient[ií]fica)\b/i] },
    rationale: 'Scientific paper lookup — route to /api/scientific-search.',
  },
  {
    id: 'rag.query',
    triggers: { intents: ['analyze', 'search', 'explain'], supernodes: ['data'] },
    rationale: 'Document Q&A — route through RAG with the operational runtime.',
  },
  {
    id: 'gmail.compose',
    triggers: { cues: [/\b(correo|email|gmail|mensaje\s+por\s+correo)\b/i, /\b(redacta|env[ií]a|compone)\b/i] },
    rationale: 'Email composition / Gmail action.',
  },
  {
    id: 'paraphrase',
    triggers: { cues: [/\b(parafrasea|reescribe|humaniza|reword|paraphrase|stealth)\b/i] },
    rationale: 'Paraphrase / humanize text — route to /api/paraphrase.',
  },
  {
    id: 'codex.run',
    triggers: { intents: ['fix', 'modify', 'create'], cues: [/\b(repositorio|repo|github|pull\s+request|pr\b|branch|commit)\b/i] },
    rationale: 'Repository-level coding task — route through Codex orchestrator.',
  },
];

function safeText(v) { return String(v == null ? '' : v).slice(0, 4000); }

function tokensInPrompt(promptText) {
  return safeText(promptText)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_\s.-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreSkill(catEntry, { intents, supernodes, prompt }) {
  let score = 0;
  let hits = 0;
  const t = catEntry.triggers || {};
  if (Array.isArray(t.intents)) {
    const matched = t.intents.filter((i) => intents.has(i)).length;
    if (matched) {
      score += 0.35 * (matched / t.intents.length);
      hits += matched;
    }
  }
  if (Array.isArray(t.supernodes)) {
    const matched = t.supernodes.filter((s) => supernodes.has(s)).length;
    if (matched) {
      score += 0.25 * (matched / t.supernodes.length);
      hits += matched;
    }
  }
  if (Array.isArray(t.cues)) {
    let cueHits = 0;
    for (const re of t.cues) if (re.test(prompt)) cueHits += 1;
    if (cueHits) {
      score += 0.4 * Math.min(1, cueHits / t.cues.length);
      hits += cueHits;
    }
  }
  return { score: Math.min(1, score), hits };
}

function recommend({
  prompt = '',
  engineBundle = null,
  additionalSkills = [],
  limit = 3,
} = {}) {
  const safePrompt = safeText(prompt);
  const intents = new Set();
  const supernodes = new Set();
  if (engineBundle?.concepts) {
    for (const c of engineBundle.concepts) {
      if (c.type === 'action') intents.add(c.normalized);
      const canon = conceptSim.canonical(c);
      if (canon) supernodes.add(canon);
    }
  } else {
    const { concepts } = conceptExtractor.extractConcepts(safePrompt);
    for (const c of concepts) {
      if (c.type === 'action') intents.add(c.normalized);
      const canon = conceptSim.canonical(c);
      if (canon) supernodes.add(canon);
    }
  }

  const catalogue = [...SKILL_CATALOGUE, ...(Array.isArray(additionalSkills) ? additionalSkills : [])];
  const scored = catalogue
    .map((entry) => {
      const { score, hits } = scoreSkill(entry, { intents, supernodes, prompt: safePrompt });
      return { id: entry.id, score: Number(score.toFixed(3)), hits, rationale: entry.rationale, params: entry.params || null };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 3)));
  return {
    primary: top[0] || null,
    alternatives: top.slice(1),
    intentSet: [...intents],
    supernodeSet: [...supernodes],
  };
}

function buildRecommendationBlock(result) {
  if (!result || !result.primary) return '';
  const lines = ['## SUGGESTED SKILL'];
  lines.push(`Primary: **${result.primary.id}** (score ${result.primary.score}) — ${result.primary.rationale}`);
  if (result.primary.params) lines.push(`  Suggested params: ${JSON.stringify(result.primary.params)}`);
  if (result.alternatives.length) {
    lines.push('Alternatives:');
    for (const a of result.alternatives) lines.push(`- ${a.id} (score ${a.score}) — ${a.rationale}`);
  }
  return lines.join('\n');
}

module.exports = {
  recommend,
  buildRecommendationBlock,
  SKILL_CATALOGUE,
};
