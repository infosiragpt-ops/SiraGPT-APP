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

function loadOptionalSkills(upstreamRoot = DEFAULT_UPSTREAM_ROOT) {
  return loadHermesUpstreamSkills(upstreamRoot).filter((s) => s.source === 'optional-skills');
}

function searchOptionalSkills(query, opts = {}) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length >= 3);
  const skills = loadOptionalSkills(opts.upstreamRoot);
  if (terms.length === 0) return skills.slice(0, opts.limit || 20);

  return skills
    .map((skill) => {
      const haystack = `${skill.id} ${skill.description} ${skill.folder}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      return { ...skill, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 20);
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

  return {
    ok: true,
    skill: {
      id: skill.id,
      folder: skill.folder,
      description: skill.description,
      source: 'optional-skills',
    },
    adaptedSkills: adapted,
    recommendations: recommendations.slice(0, 5),
    instructionPreview: body.slice(0, 1200),
    activation: adapted.length > 0 ? 'use_siragpt_skills' : 'reference_only',
  };
}

function status(opts = {}) {
  const skills = loadOptionalSkills(opts.upstreamRoot);
  return {
    total: skills.length,
    mapped: skills.filter((s) => (UPSTREAM_TO_SIRAGPT_SKILLS[s.id] || []).length > 0).length,
  };
}

module.exports = {
  loadOptionalSkills,
  searchOptionalSkills,
  activateOptionalSkill,
  status,
};
