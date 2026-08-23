'use strict';

/**
 * OpenSpec skills that /code must keep loadable (instruction SKILL.md).
 * Engine waves used to drop these folders because they lived beside the
 * handler-style skills and were never in the agent-runner builtin root.
 */

const path = require('path');

const OPENSPEC_SKILLS = Object.freeze([
  'openspec-apply-change',
  'openspec-archive-change',
  'openspec-explore',
  'openspec-propose',
  'openspec-sync-specs',
  'openspec-update-change',
]);

function openspecSkillsRoot() {
  return __dirname;
}

function listOpenspecSkillDirs() {
  return OPENSPEC_SKILLS.map((name) => path.join(__dirname, name));
}

module.exports = {
  OPENSPEC_SKILLS,
  openspecSkillsRoot,
  listOpenspecSkillDirs,
};
