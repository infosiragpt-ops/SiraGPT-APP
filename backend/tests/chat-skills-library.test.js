'use strict';

// Ajustes → Skills (claude.ai style): «Tuyos» (own + SiraGPT skills), the
// «Descubrir» catalog ranked with the user's memory, install / switch off /
// delete, create / upload / edit, SKILL.md download and the agent's
// save_skill tool (procedural memory).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const chatSkills = require('../src/services/chat-skills');
const persist = require('../src/services/skills-persist');
const catalog = require('../src/services/skills-catalog');
const { buildSaveSkillTool } = require('../src/services/agent-harness/tools/save-skill-tool');
const { buildUseSkillTool } = require('../src/services/agent-harness/tools/use-skill-tool');
const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
const { createChatSkillsRouter } = require('../src/routes/chat-skills');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCatalog() {
  const dir = tmpDir('sira-skills-catalog-');
  const file = (name, meta, body) => fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${meta}\n---\n${body}\n`);
  file('skill-creator', 'name: skill-creator\ntitle: Creador de skills\ndescription: Crea skills nuevas contigo.\ncategory: Modelos y agentes de IA\nadded: 2026-09-30', '# Creador de skills\nEntrevista y usa save_skill.');
  file('analisis-datos', 'name: analisis-datos\ntitle: Análisis de datos\ndescription: Analiza hojas de cálculo y datos CSV.\ncategory: Datos y análisis\nadded: 2026-09-30\nfeatured: true', '# Análisis de datos\nPerfila los datos primero.');
  file('sql-avanzado', 'name: sql-avanzado\ntitle: SQL avanzado\ndescription: Consultas SQL con CTE y funciones de ventana.\ncategory: Datos y análisis\nadded: 2026-09-22', '# SQL avanzado\nUsa EXPLAIN.');
  file('citas-apa', 'name: citas-apa\ntitle: Citas APA 7\ndescription: Referencias académicas en formato APA 7 para tesis.\ncategory: Investigación\nadded: 2026-09-22', '# Citas APA 7\nAutor, año.');
  fs.writeFileSync(path.join(dir, 'roto.md'), 'sin frontmatter');
  catalog.reloadCatalog({ dir });
  return dir;
}

function bound(root) {
  const store = {
    listPersistedSkills: (a) => persist.listPersistedSkills({ ...a, root }),
    loadPersistedSkill: (a) => persist.loadPersistedSkill({ ...a, root }),
    persistUserSkill: (a) => persist.persistUserSkill({ ...a, root }),
    deletePersistedSkill: (a) => persist.deletePersistedSkill({ ...a, root }),
    readSkillState: (a) => persist.readSkillState({ ...a, root }),
    writeSkillState: (a) => persist.writeSkillState({ ...a, root }),
  };
  const withStore = (fn) => (args = {}) => fn({ ...args, persist: store });
  return {
    ...chatSkills,
    store,
    listChatSkills: withStore(chatSkills.listChatSkills),
    loadChatSkill: withStore(chatSkills.loadChatSkill),
    getSkillState: withStore(chatSkills.getSkillState),
    listSkillLibrary: withStore(chatSkills.listSkillLibrary),
    discoverSkills: withStore(chatSkills.discoverSkills),
    createUserSkill: withStore(chatSkills.createUserSkill),
    updateUserSkill: withStore(chatSkills.updateUserSkill),
    setSkillEnabled: withStore(chatSkills.setSkillEnabled),
    installCatalogSkill: withStore(chatSkills.installCatalogSkill),
    removeSkill: withStore(chatSkills.removeSkill),
  };
}

test.before(() => { writeCatalog(); });
test.after(() => { catalog.reloadCatalog(); });

test('catalog loader parses frontmatter, skips broken files and counts real categories', () => {
  const items = catalog.listCatalogSkills();
  assert.deepEqual(items.map((s) => s.name).sort(), ['analisis-datos', 'citas-apa', 'skill-creator', 'sql-avanzado']);
  assert.ok(items.every((s) => !('body' in s)), 'listing never ships bodies');
  assert.equal(catalog.getCatalogSkill('analisis-datos').featured, true);
  assert.deepEqual(catalog.catalogCategories(items)[0], { name: 'Datos y análisis', count: 2 });
});

test('«Tuyos» splits own skills from SiraGPT ones; skill-creator ships installed', () => {
  const skills = bound(tmpDir('sira-skills-'));
  skills.createUserSkill({ userId: 'u1', name: 'informe-ucv', description: 'Formato UCV para informes', body: '# UCV\nAPA 7.' });
  const { mine, partners } = skills.listSkillLibrary({ userId: 'u1' });
  assert.deepEqual(mine.map((s) => s.name), ['informe-ucv']);
  assert.equal(mine[0].author, 'por ti');
  assert.equal(mine[0].enabled, true);
  assert.ok(mine[0].updatedAt, 'own skills carry their date');
  assert.deepEqual(partners.map((s) => s.name), ['docx', 'pptx', 'xlsx', 'pdf', 'csv', 'skill-creator']);
  assert.ok(partners.every((s) => s.author === 'SiraGPT'));
  assert.equal(partners.find((s) => s.name === 'docx').removable, false);
});

test('installing from «Descubrir» adds it to the composer; uninstalling removes it (defaults stay removed)', () => {
  const skills = bound(tmpDir('sira-skills-'));
  const before = skills.listChatSkills({ userId: 'u2' }).map((s) => s.name);
  assert.ok(!before.includes('sql-avanzado'));
  assert.ok(before.includes('skill-creator'));
  skills.installCatalogSkill({ userId: 'u2', name: 'sql-avanzado', now: new Date('2026-09-30T10:00:00Z') });
  const after = skills.listChatSkills({ userId: 'u2' });
  assert.equal(after.find((s) => s.name === 'sql-avanzado').source, 'catalog');
  assert.equal(skills.listSkillLibrary({ userId: 'u2' }).partners.find((s) => s.name === 'sql-avanzado').updatedAt, '2026-09-30T10:00:00.000Z');
  skills.removeSkill({ userId: 'u2', name: 'sql-avanzado' });
  skills.removeSkill({ userId: 'u2', name: 'skill-creator' });
  const names = skills.listChatSkills({ userId: 'u2' }).map((s) => s.name);
  assert.ok(!names.includes('sql-avanzado') && !names.includes('skill-creator'), names.join(','));
  assert.throws(() => skills.installCatalogSkill({ userId: 'u2', name: 'no-existe' }), (e) => e.status === 404);
  assert.throws(() => skills.removeSkill({ userId: 'u2', name: 'docx' }), (e) => e.status === 400 && /desactivarlas/.test(e.message));
});

test('a switched-off skill leaves the composer and use_skill, but an explicit pick still resolves', async () => {
  const skills = bound(tmpDir('sira-skills-'));
  skills.setSkillEnabled({ userId: 'u3', name: 'xlsx', enabled: false });
  assert.ok(!skills.listChatSkills({ userId: 'u3' }).some((s) => s.name === 'xlsx'));
  assert.ok(skills.listChatSkills({ userId: 'u3', includeDisabled: true }).some((s) => s.name === 'xlsx'));
  assert.equal(skills.listSkillLibrary({ userId: 'u3' }).partners.find((s) => s.name === 'xlsx').enabled, false);
  assert.equal(skills.loadChatSkill({ userId: 'u3', name: 'xlsx', respectDisabled: true }), null);
  assert.equal(skills.loadChatSkill({ userId: 'u3', name: 'xlsx' }).source, 'builtin');
  const tool = buildUseSkillTool();
  const res = await tool.execute({ name: 'xlsx' }, { userId: 'u3', chatSkills: skills });
  assert.equal(res.ok, false);
  skills.setSkillEnabled({ userId: 'u3', name: 'xlsx', enabled: true });
  assert.ok(skills.listChatSkills({ userId: 'u3' }).some((s) => s.name === 'xlsx'));
  assert.throws(() => skills.setSkillEnabled({ userId: 'u3', name: 'fantasma', enabled: false }), (e) => e.status === 404);
});

test('catalog skills resolve for «Probar» without installing', () => {
  const skills = bound(tmpDir('sira-skills-'));
  const skill = skills.loadChatSkill({ userId: 'u4', name: 'citas-apa' });
  assert.equal(skill.source, 'catalog');
  assert.match(skill.body, /Autor, año/);
  const { skills: picked } = chatSkills.resolveSelectedSkills({ userId: 'u4', names: ['citas-apa'], persist: skills.store });
  assert.equal(picked.length, 1);
});

test('create validates names, descriptions, reserved and duplicate names; edit and upload work', () => {
  const skills = bound(tmpDir('sira-skills-'));
  const ok = { userId: 'u5', name: 'acta', description: 'Actas de reunión', body: '# Acta\nDecisiones.' };
  assert.equal(skills.createUserSkill(ok).name, 'acta');
  assert.throws(() => skills.createUserSkill(ok), (e) => e.status === 409 && e.code === 'name_taken');
  assert.throws(() => skills.createUserSkill({ ...ok, name: 'Mala Skill' }), (e) => e.status === 400 && e.code === 'invalid_name');
  assert.throws(() => skills.createUserSkill({ ...ok, name: 'docx' }), (e) => e.code === 'name_reserved');
  assert.throws(() => skills.createUserSkill({ ...ok, name: 'citas-apa' }), (e) => e.code === 'name_reserved');
  assert.throws(() => skills.createUserSkill({ ...ok, name: 'otra', description: 'x'.repeat(161) }), (e) => e.code === 'description_too_long');
  assert.throws(() => skills.createUserSkill({ ...ok, name: 'otra', body: '  ' }), (e) => e.code === 'body_required');
  assert.throws(() => chatSkills.createUserSkill({ ...ok, userId: '' }), (e) => e.status === 401);
  const edited = skills.updateUserSkill({ userId: 'u5', name: 'acta', description: 'Actas con responsables', body: '# Acta v2' });
  assert.equal(edited.description, 'Actas con responsables');
  assert.throws(() => skills.updateUserSkill({ userId: 'u5', name: 'docx', description: 'x', body: 'y' }), (e) => e.status === 404);
  const uploaded = chatSkills.parseUploadedSkill('---\nname: Subida\ndescription: Desde un archivo\n---\n# Cuerpo', 'SKILL.md');
  assert.deepEqual([uploaded.name, uploaded.description], ['subida', 'Desde un archivo']);
  assert.equal(chatSkills.parseUploadedSkill('# Sin encabezado\ncuerpo', 'mi-skill.md').name, 'mi-skill');
  assert.throws(() => chatSkills.parseUploadedSkill('# x', 'SKILL.md'), (e) => e.code === 'invalid_skill');
  assert.throws(() => chatSkills.parseUploadedSkill(''), (e) => e.code === 'empty_upload');
  const md = chatSkills.exportSkillMarkdown(skills.loadChatSkill({ userId: 'u5', name: 'acta' }));
  assert.match(md, /^---\nname: acta\ndescription: Actas con responsables\n---/);
  assert.deepEqual(skills.removeSkill({ userId: 'u5', name: 'acta' }), { name: 'acta', deleted: true });
});

test('«Descubrir» ranks «Para ti» with the user memory and flags installed skills', () => {
  const skills = bound(tmpDir('sira-skills-'));
  skills.installCatalogSkill({ userId: 'u6', name: 'citas-apa' });
  const found = skills.discoverSkills({ userId: 'u6', memoryText: 'Está escribiendo su tesis de maestría con referencias académicas en APA.' });
  assert.equal(found.featured.name, 'analisis-datos');
  assert.equal(found.forYou[0].name, 'citas-apa');
  assert.equal(found.forYou[0].personalised, true);
  assert.equal(found.items.find((s) => s.name === 'citas-apa').installed, true);
  assert.equal(found.total, 4);
  assert.deepEqual(found.latest.slice(0, 2).map((s) => s.added), ['2026-09-30', '2026-09-30']);
  const neutral = skills.discoverSkills({ userId: 'u6', memoryText: '' });
  assert.ok(neutral.forYou.every((s) => !s.personalised));
  assert.deepEqual(skills.discoverSkills({ userId: 'u6', query: 'sql' }).items.map((s) => s.name), ['sql-avanzado']);
  assert.deepEqual(skills.discoverSkills({ userId: 'u6', category: 'Investigación' }).items.map((s) => s.name), ['citas-apa']);
});

test('state file is atomic, dot-named and never listed as a skill', () => {
  const root = tmpDir('sira-skills-');
  persist.writeSkillState({ userId: 'u7', root, state: { installed: { 'citas-apa': '2026-09-30T00:00:00Z', '../x': 'bad' }, disabled: ['docx', 'Bad Name'] } });
  const state = persist.readSkillState({ userId: 'u7', root });
  assert.deepEqual(Object.keys(state.installed), ['citas-apa']);
  assert.deepEqual(state.disabled, ['docx']);
  assert.deepEqual(persist.listPersistedSkills({ userId: 'u7', root }), []);
  assert.deepEqual(persist.readSkillState({ userId: 'nadie', root }), { installed: {}, disabled: [], removed: [] });
});

test('save_skill saves an approved skill after confirmation and reports clear errors', async () => {
  const skills = bound(tmpDir('sira-skills-'));
  const tool = buildSaveSkillTool();
  assert.equal(tool.name, 'save_skill');
  assert.equal(tool.permissionTier, 'confirm');
  assert.match(tool.humanDescription({ name: 'informe-semanal' }), /informe-semanal/);
  const saved = await tool.execute({ name: 'informe-semanal', description: 'Informe semanal del equipo', body: '# Informe\nPasos.' }, { userId: 'u8', chatSkills: skills });
  assert.equal(saved.ok, true);
  assert.ok(skills.listChatSkills({ userId: 'u8' }).some((s) => s.name === 'informe-semanal'));
  const dup = await tool.execute({ name: 'informe-semanal', description: 'x', body: 'y' }, { userId: 'u8', chatSkills: skills });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /Ya tienes/);
  const replaced = await tool.execute({ name: 'informe-semanal', description: 'v2', body: '# v2', overwrite: true }, { userId: 'u8', chatSkills: skills });
  assert.equal(replaced.ok, true);
  assert.equal((await tool.execute({ name: 'a', description: 'b', body: 'c' }, {})).ok, false);
  assert.ok(tool.inputSchema.safeParse({ name: 'x', description: 'y', body: 'z' }).success);
  assert.ok(!tool.inputSchema.safeParse({ name: 'x', description: 'y'.repeat(161), body: 'z' }).success);
  assert.ok(buildHarnessTools(new Set()).some((d) => d.name === 'save_skill'));
});

test('HTTP: library, create, upload, switch off, install, download, discover and delete', async () => {
  const skills = bound(tmpDir('sira-skills-'));
  const fakeAuth = (req, _res, next) => { req.user = { id: 'u-http' }; next(); };
  const app = express();
  app.use(express.json());
  app.use('/api/skills', createChatSkillsRouter({ auth: fakeAuth, skills, memorySignal: async () => 'tesis APA referencias' }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/skills`;
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await fetch(base, json('POST', { name: 'propia', description: 'Mi skill', body: '# Propia' }));
    assert.equal(created.status, 201);
    const dup = await fetch(base, json('POST', { name: 'propia', description: 'Mi skill', body: '# Propia' }));
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /Ya tienes/);
    const up = await fetch(base, json('POST', { content: '---\nname: subida\ndescription: Subida\n---\n# Cuerpo', filename: 'SKILL.md' }));
    assert.equal(up.status, 201);
    const library = await (await fetch(`${base}/library`)).json();
    assert.deepEqual(library.mine.map((s) => s.name).sort(), ['propia', 'subida']);
    const off = await fetch(`${base}/propia`, json('PATCH', { enabled: false }));
    assert.equal(off.status, 200);
    assert.equal((await fetch(`${base}/propia`, json('PATCH', {}))).status, 400);
    const composer = await (await fetch(base)).json();
    assert.ok(!composer.skills.some((s) => s.name === 'propia'));
    const installed = await fetch(`${base}/sql-avanzado/install`, json('POST', {}));
    assert.equal(installed.status, 200);
    const detail = await (await fetch(`${base}/sql-avanzado`)).json();
    assert.equal(detail.skill.source, 'catalog');
    assert.equal(detail.skill.enabled, true);
    const dl = await fetch(`${base}/propia/download`);
    assert.match(dl.headers.get('content-disposition'), /propia-SKILL\.md/);
    assert.match(await dl.text(), /name: propia/);
    const edited = await fetch(`${base}/propia`, json('PUT', { description: 'Editada', body: '# Editada' }));
    assert.equal((await edited.json()).skill.description, 'Editada');
    const discover = await (await fetch(`${base}/discover`)).json();
    assert.equal(discover.memoryUsed, true);
    assert.equal(discover.forYou[0].name, 'citas-apa');
    assert.ok(discover.categories.some((c) => c.name === 'Datos y análisis' && c.count === 2));
    assert.equal((await fetch(`${base}/propia`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/docx`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${base}/no-existe`, { method: 'DELETE' })).status, 404);
  } finally {
    server.close();
  }
});
