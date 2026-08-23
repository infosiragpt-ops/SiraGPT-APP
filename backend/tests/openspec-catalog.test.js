'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { OPENSPEC_SKILLS, listOpenspecSkillDirs, openspecSkillsRoot } = require('../src/skills/openspec-catalog');
const { listSkills, loadSkill } = require('../src/services/agent-runner/skills');

describe('OpenSpec catalog in /code agent-runner', () => {
  it('keeps the six instruction SKILL.md folders on disk', () => {
    assert.equal(OPENSPEC_SKILLS.length, 6);
    for (const dir of listOpenspecSkillDirs()) {
      assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), dir);
    }
    assert.equal(openspecSkillsRoot(), path.join(__dirname, '../src/skills'));
  });

  it('lists OpenSpec skills from the default agent-runner roots', () => {
    const names = listSkills({ env: { ...process.env, SIRAGPT_AGENT_SKILLS: '1' } }).map((s) => s.name);
    for (const name of OPENSPEC_SKILLS) {
      assert.ok(names.includes(name), `missing ${name} in ${names.join(',')}`);
    }
  });

  it('load_skill returns OpenSpec propose playbook as framed data', () => {
    const loaded = loadSkill('openspec-propose', { env: { ...process.env, SIRAGPT_AGENT_SKILLS: '1' } });
    assert.equal(loaded.ok, true);
    assert.match(loaded.body, /OpenSpec|openspec/i);
  });
});
