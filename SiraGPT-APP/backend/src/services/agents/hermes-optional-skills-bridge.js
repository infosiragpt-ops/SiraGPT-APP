'use strict';

/**
 * Hermes optional-skills bridge — on-demand activation of upstream optional skills.
 */

const fs = require('fs');
const path = require('path');
const {
  loadHermesUpstreamSkills,
  recommendAdaptedPlaybooks,
  UPSTREAM_TO_SIRAGPT_SKILLS,
} = require('./hermes-playbook-bridge');

const DEFAULT_UPSTREAM_ROOT = path.join(process.cwd(), '.agents', 'hermes-upstream');
const DEFAULT_LIMIT = 20;

function tokenize(input) {
  const stopWords = new Set(['con', 'los', 'las', 'para', 'por', 'que', 'the', 'and', 'with', 'from']);
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function loadOptionalSkills(upstreamRoot = DEFAULT_UPSTREAM_ROOT) {
  return loadHermesUpstreamSkills(upstreamRoot)
    .filter((s) => s.source === 'optional-skills')
    .map(enrichOptionalSkill);
}

function optionalSkillCategory(skill) {
  const parts = String(skill.folder || '').split('/').filter(Boolean);
  if (parts[0] === 'optional-skills' || parts[0] === 'skills') return parts[1] || 'general';
  return parts[0] || 'general';
}

function skillCoverageStatus(skillId) {
  return (UPSTREAM_TO_SIRAGPT_SKILLS[skillId] || []).length > 0 ? 'mapped' : 'reference-only';
}

function enrichOptionalSkill(skill) {
  const adaptedSkills = UPSTREAM_TO_SIRAGPT_SKILLS[skill.id] || [];
  return {
    ...skill,
    category: optionalSkillCategory(skill),
    status: adaptedSkills.length > 0 ? 'mapped' : 'reference-only',
    adaptedSkills,
  };
}

function summarizeOptionalSkills(skills) {
  const byCategory = {};
  const byStatus = {};
  for (const skill of skills) {
    byCategory[skill.category] = (byCategory[skill.category] || 0) + 1;
    byStatus[skill.status] = (byStatus[skill.status] || 0) + 1;
  }
  return {
    total: skills.length,
    mapped: byStatus.mapped || 0,
    referenceOnly: byStatus['reference-only'] || 0,
    categories: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
    statuses: byStatus,
  };
}

function scoreOptionalSkill(skill, terms) {
  const haystack = [
    skill.id,
    skill.description,
    skill.folder,
    skill.category,
    skill.status,
    ...skill.adaptedSkills,
  ].join(' ').toLowerCase();
  const matchedTerms = terms.filter((t) => haystack.includes(t));
  const score = matchedTerms.reduce((sum, term) => {
    if (skill.id.toLowerCase().includes(term)) return sum + 4;
    if (skill.category.toLowerCase().includes(term)) return sum + 3;
    if (skill.folder.toLowerCase().includes(term)) return sum + 2;
    return sum + 1;
  }, skill.status === 'mapped' ? 1 : 0);
  return { score, matchedTerms };
}

function searchOptionalSkills(query, opts = {}) {
  const terms = tokenize(query);
  const skills = loadOptionalSkills(opts.upstreamRoot);
  const limit = opts.limit || DEFAULT_LIMIT;
  if (terms.length === 0) return skills.slice(0, limit);

  return skills
    .map((skill) => {
      const { score, matchedTerms } = scoreOptionalSkill(skill, terms);
      return { ...skill, score, matchedTerms };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function activateOptionalSkill(skillId, opts = {}) {
  const skills = loadOptionalSkills(opts.upstreamRoot);
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return { ok: false, reason: 'skill_not_found' };

  let body = '';
  try {
    body = fs.readFileSync(skill.path, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'skill_read_failed', error: err.message };
  }

  const adapted = UPSTREAM_TO_SIRAGPT_SKILLS[skillId] || [];
  const recommendations = recommendAdaptedPlaybooks(skillId, opts);
  const activation = adapted.length > 0 ? 'use_siragpt_skills' : 'reference_only';

  return {
    ok: true,
    skill: {
      id: skill.id,
      folder: skill.folder,
      category: skill.category,
      description: skill.description,
      source: 'optional-skills',
      status: skillCoverageStatus(skill.id),
    },
    adaptedSkills: adapted,
    recommendations: recommendations.slice(0, 5),
    instructionPreview: body.slice(0, 1200),
    activation,
    adaptationPlan: {
      mode: activation,
      sourcePolicy: 'MIT upstream reference only; rewrite behavior into SiraGPT-native services/skills before runtime activation.',
      nextStep: adapted.length > 0
        ? 'Use the mapped active SiraGPT playbooks first, then port only missing behavior with focused tests.'
        : 'Treat the upstream skill as research input and create a new SiraGPT playbook or backend adapter before exposing it.',
    },
  };
}

function status(opts = {}) {
  const skills = loadOptionalSkills(opts.upstreamRoot);
  return summarizeOptionalSkills(skills);
}

module.exports = {
  loadOptionalSkills,
  searchOptionalSkills,
  activateOptionalSkill,
  summarizeOptionalSkills,
  status,
};
