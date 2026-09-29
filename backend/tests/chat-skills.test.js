'use strict';

// Agent Skills for the /agentes chat (claude.ai style): catalog = built-in
// document skills + the user's Biblioteca; explicit selection rides the turn
// as a load-bearing block; `use_skill` loads a body on demand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const chatSkills = require('../src/services/chat-skills');
const persist = require('../src/services/skills-persist');
const { buildUseSkillTool } = require('../src/services/agent-harness/tools/use-skill-tool');
const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
const { createChatSkillsRouter } = require('../src/routes/chat-skills');
const promptKernel = require('../src/services/prompt-kernel');
const { TIER_BY_KIND } = require('../src/services/prompt-budget-allocator');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sira-chat-skills-'));
}

function boundPersist(root) {
  return {
    listPersistedSkills: (args) => persist.listPersistedSkills({ ...args, root }),
    loadPersistedSkill: (args) => persist.loadPersistedSkill({ ...args, root }),
  };
}

test('catalog lists the built-in document skills first, then the user Biblioteca', () => {
  const root = tmpRoot();
  persist.persistUserSkill({ userId: 'u1', name: 'informe-ucv', description: 'Formato UCV para informes', body: '# Informe UCV\nUsa APA 7.', root });
  const catalog = chatSkills.listChatSkills({ userId: 'u1', persist: boundPersist(root) });
  assert.deepEqual(catalog.slice(0, 5).map((s) => s.name), ['docx', 'pptx', 'xlsx', 'pdf', 'csv']);
  assert.ok(catalog.slice(0, 5).every((s) => s.source === 'builtin' && s.title && s.description));
  const mine = catalog.find((s) => s.name === 'informe-ucv');
  assert.ok(mine);
  assert.equal(mine.source, 'biblioteca');
  assert.equal(mine.description, 'Formato UCV para informes');
  assert.equal(catalog.filter((s) => s.name === 'informe-ucv').length, 1);
});

test('without a user only the built-ins are listed; a user skill never shadows a built-in', () => {
  const root = tmpRoot();
  persist.persistUserSkill({ userId: 'u1', name: 'docx', description: 'fake', body: 'shadow', root });
  assert.equal(chatSkills.listChatSkills({}).length, 5);
  const skill = chatSkills.loadChatSkill({ userId: 'u1', name: 'docx', persist: boundPersist(root) });
  assert.equal(skill.source, 'builtin');
  assert.match(skill.body, /Skill/);
  assert.doesNotMatch(skill.body, /^shadow$/);
});

test('selected names are validated, de-duplicated and capped at 3', () => {
  assert.deepEqual(chatSkills.normalizeSelectedSkillNames(['DOCX', '/pptx', 'docx', '../etc', '', 'xlsx', 'pdf']), ['docx', 'pptx', 'xlsx']);
  assert.deepEqual(chatSkills.normalizeSelectedSkillNames('pdf'), ['pdf']);
  assert.deepEqual(chatSkills.normalizeSelectedSkillNames(null), []);
  assert.deepEqual(chatSkills.normalizeSelectedSkillNames([{ name: 'csv' }]), ['csv']);
});

test('resolveSelectedSkills loads bodies and reports unknown names; the block is capped', () => {
  const root = tmpRoot();
  persist.persistUserSkill({ userId: 'u1', name: 'larga', description: 'x', body: 'a'.repeat(15000), root });
  const { skills, missing } = chatSkills.resolveSelectedSkills({ userId: 'u1', names: ['docx', 'larga', 'no-existe'], persist: boundPersist(root) });
  assert.deepEqual(skills.map((s) => s.name), ['docx', 'larga']);
  assert.deepEqual(missing, ['no-existe']);
  const block = chatSkills.buildSelectedSkillsBlock(skills);
  assert.match(block, /## Skills activas en este turno/);
  assert.match(block, /### Skill: Word \(docx\)/);
  assert.match(block, /### Skill: larga/);
  assert.match(block, /skill recortada/);
  assert.ok(block.length <= chatSkills.MAX_TOTAL_PROMPT_CHARS + 1200, `block ${block.length}`);
  assert.equal(chatSkills.buildSelectedSkillsBlock([]), '');
});

test('parseSkillMarkdown reads frontmatter and falls back to the first line', () => {
  const parsed = chatSkills.parseSkillMarkdown('---\nname: Mi-Skill\ndescription: Hace cosas\n---\n# Título\ncuerpo');
  assert.equal(parsed.name, 'mi-skill');
  assert.equal(parsed.description, 'Hace cosas');
  assert.match(parsed.body, /cuerpo/);
  const bare = chatSkills.parseSkillMarkdown('# Revisión legal\nPasos…', 'legal');
  assert.equal(bare.name, 'legal');
  assert.equal(bare.description, 'Revisión legal');
  assert.equal(chatSkills.parseSkillMarkdown('x', '../bad'), null);
});

test('use_skill lists the catalog without a name and returns the playbook with one', async () => {
  const tool = buildUseSkillTool();
  assert.equal(tool.name, 'use_skill');
  assert.equal(tool.permissionTier, 'auto');
  const listed = await tool.execute({}, { userId: null });
  assert.equal(listed.ok, true);
  assert.match(listed.catalog, /- docx: /);
  const loaded = await tool.execute({ name: 'xlsx' }, { userId: null });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.title, 'Excel');
  assert.match(loaded.instructions, /XLSX/);
  const missing = await tool.execute({ name: 'nada' }, { userId: null });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No existe la skill/);
});

test('the harness registers use_skill for every agent turn', () => {
  const names = buildHarnessTools(new Set()).map((d) => d.name);
  assert.ok(names.includes('use_skill'), names.join(','));
  assert.ok(!buildHarnessTools(new Set(['use_skill'])).some((d) => d.name === 'use_skill'));
});

test('the selected-skills block is never pruned nor trimmed', () => {
  const plan = promptKernel.planBlocks({ difficulty: { bucket: 'trivial' }, presentKinds: ['selected-skills', 'attribution'] });
  assert.ok(plan.keep.includes('selected-skills'));
  assert.ok(plan.drop.includes('attribution'));
  assert.equal(TIER_BY_KIND['selected-skills'], 0);
});

test('GET /api/skills lists the catalog and GET /api/skills/:name returns one body', async () => {
  const fakeAuth = (req, _res, next) => { req.user = { id: 'u-route' }; next(); };
  const app = express();
  app.use('/api/skills', createChatSkillsRouter({ auth: fakeAuth }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/skills`;
    const list = await (await fetch(base)).json();
    assert.equal(list.ok, true);
    assert.ok(list.skills.some((s) => s.name === 'pptx' && s.title === 'PowerPoint'));
    assert.ok(list.skills.every((s) => !('body' in s)), 'the catalog never ships bodies');
    const one = await (await fetch(`${base}/pdf`)).json();
    assert.equal(one.ok, true);
    assert.match(one.skill.body, /PDF/i);
    const bad = await fetch(`${base}/..%2Fetc`);
    assert.equal(bad.status, 400);
    const none = await fetch(`${base}/no-existe`);
    assert.equal(none.status, 404);
  } finally {
    server.close();
  }
});
