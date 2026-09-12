'use strict';

/**
 * codex/skills — offline unit tests.
 *
 * Covers: builtin catalog integrity, frontmatter parsing + validation caps,
 * workspace loading via a fake runner (best-effort failure modes, builtin
 * shadowing rejected), the use_skill tool contract (load + catalog fallback)
 * and the system-prompt line.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const skills = require('../src/services/codex/skills');
const buildTools = require('../src/services/codex/build-tools');

test('builtin catalog: every skill is well-formed and unique', () => {
  const names = new Set();
  assert.ok(skills.BUILTIN_SKILLS.length >= 5);
  for (const s of skills.BUILTIN_SKILLS) {
    assert.match(s.name, /^[a-z][a-z0-9-]{1,39}$/, s.name);
    assert.ok(s.description.length > 10 && s.description.length <= 160, s.name);
    assert.ok(s.body.length > 200 && s.body.length <= skills.MAX_SKILL_BODY_CHARS, s.name);
    assert.ok(!names.has(s.name), `duplicate ${s.name}`);
    names.add(s.name);
  }
});

test('parseSkillMarkdown: frontmatter, fallback name, and rejection rules', () => {
  const withFm = skills.parseSkillMarkdown('---\nname: mi-skill\ndescription: Hace algo útil\n---\n# Cuerpo\npasos…', 'archivo');
  assert.equal(withFm.name, 'mi-skill');
  assert.equal(withFm.description, 'Hace algo útil');
  assert.match(withFm.body, /^# Cuerpo/);

  const noFm = skills.parseSkillMarkdown('# Título\nprimera línea útil', 'skill-simple');
  assert.equal(noFm.name, 'skill-simple');
  assert.equal(noFm.description, 'primera línea útil');

  assert.equal(skills.parseSkillMarkdown('cuerpo', 'Nombre Inválido!'), null);
  assert.equal(skills.parseSkillMarkdown('', 'valido'), null);
  // Oversized body is capped, not rejected.
  const big = skills.parseSkillMarkdown(`x${'y'.repeat(20000)}`, 'grande');
  assert.equal(big.body.length, skills.MAX_SKILL_BODY_CHARS);
});

function fakeRunner({ files = {}, lsOut = null, lsThrows = false } = {}) {
  return {
    exec: async (_p, cmd) => {
      if (lsThrows) throw new Error('runner down');
      if (cmd[0] === 'ls') return { stdout: lsOut ?? Object.keys(files).join('\n'), exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
    readFile: async (_p, path) => {
      const name = path.replace('.sira/skills/', '');
      if (!(name in files)) throw new Error('not found');
      return { content: files[name] };
    },
  };
}

test('loadWorkspaceSkills: loads valid .md, skips broken, never shadows builtins', async () => {
  const runner = fakeRunner({
    files: {
      'estilo-marca.md': '---\nname: estilo-marca\ndescription: Colores corporativos\n---\nUsa #FF0000 como acento.',
      'landing-profesional.md': '---\nname: landing-profesional\ndescription: shadow attempt\n---\ncuerpo malicioso',
      'roto.md': '',
      'notas.txt': 'ignorado',
    },
  });
  const out = await skills.loadWorkspaceSkills({ runner, project: 'p1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'estilo-marca');
  assert.equal(out[0].source, 'workspace');
});

test('loadWorkspaceSkills: runner failure → [] (never breaks a turn)', async () => {
  assert.deepEqual(await skills.loadWorkspaceSkills({ runner: fakeRunner({ lsThrows: true }), project: 'p1' }), []);
  assert.deepEqual(await skills.loadWorkspaceSkills({}), []);
});

test('getSkill + formatCatalog merge builtins with workspace skills', () => {
  const ws = [{ name: 'estilo-marca', description: 'Colores', body: 'X', source: 'workspace' }];
  assert.equal(skills.getSkill('landing-profesional', ws).name, 'landing-profesional');
  assert.equal(skills.getSkill('ESTILO-MARCA', ws).name, 'estilo-marca');
  assert.equal(skills.getSkill('nope', ws), null);
  const catalog = skills.formatCatalog(ws);
  assert.match(catalog, /landing-profesional/);
  assert.match(catalog, /estilo-marca \(del proyecto\)/);
});

test('skillsPromptLine names every builtin and stays one line', () => {
  const line = skills.skillsPromptLine();
  assert.ok(!line.includes('\n'));
  for (const s of skills.BUILTIN_SKILLS) assert.ok(line.includes(s.name), s.name);
});

test('use_skill tool: loads a builtin playbook as observation', async () => {
  const tool = buildTools.getTool('use_skill');
  const out = await tool.execute({ name: 'landing-profesional' }, { runner: fakeRunner({}), project: 'p1' });
  assert.equal(out.isError, false);
  assert.match(out.observation, /Hero/);
  assert.match(out.observation, /Aplica este playbook/);
});

test('use_skill tool: unknown or missing name returns the catalog', async () => {
  const tool = buildTools.getTool('use_skill');
  const unknown = await tool.execute({ name: 'inventado' }, { runner: fakeRunner({}), project: 'p1' });
  assert.equal(unknown.isError, false);
  assert.match(unknown.observation, /No hay un skill llamado "inventado"/);
  assert.match(unknown.observation, /crud-entidades/);

  const list = await tool.execute({}, { runner: fakeRunner({ lsThrows: true }), project: 'p1' });
  assert.equal(list.isError, false);
  assert.match(list.observation, /Skills disponibles:/);
});

test('use_skill tool: workspace skill reachable through the tool', async () => {
  const tool = buildTools.getTool('use_skill');
  const runner = fakeRunner({ files: { 'estilo-marca.md': '---\nname: estilo-marca\ndescription: Marca\n---\nAcento #FF0000 siempre.' } });
  const out = await tool.execute({ name: 'estilo-marca' }, { runner, project: 'p1' });
  assert.match(out.observation, /#FF0000/);
});

test('use_skill is registered in the tool registry projection', () => {
  const reg = buildTools.toolRegistry();
  const entry = reg.find((t) => t.name === 'use_skill');
  assert.ok(entry, 'use_skill must be in the registry');
  assert.ok(entry.description.includes('landing-profesional'));
});

test('detectSkillForPrompt: deterministic keyword mapping (ES/EN)', () => {
  const cases = [
    ['crea una landing page para una cafetería', 'landing-profesional'],
    ['página web promocional para mi negocio', 'landing-profesional'],
    ['haz un dashboard de ventas con KPIs', 'dashboard-kpis'],
    ['app con login y registro de usuarios', 'auth-basica'],
    ['sistema de gestión de clientes', 'crud-entidades'],
    ['un CRM para mi empresa', 'app-empresarial'],
    ['sistema de inventario para ferretería', 'app-empresarial'],
    ['formulario de contacto con validación', 'formularios-validados'],
    ['crea una tienda online de zapatillas', 'ecommerce-catalogo'],
    ['hazme un portfolio personal de diseñador', 'portfolio-personal'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(skills.detectSkillForPrompt(prompt)?.name, expected, prompt);
  }
  assert.equal(skills.detectSkillForPrompt('explícame qué es React'), null);
  assert.equal(skills.detectSkillForPrompt(''), null);
});

test('buildSystemPrompt auto-injects the detected playbook', () => {
  const { buildSystemPrompt } = require('../src/services/codex/agent-loop');
  const p = buildSystemPrompt({ project: { name: 'X' }, plan: null, fileTree: null, sourcePrompt: 'crea una landing para una cafetería' });
  assert.match(p, /PLAYBOOK APLICABLE \(landing-profesional\)/);
  assert.match(p, /Hero/);
  const p2 = buildSystemPrompt({ project: { name: 'X' }, plan: null, fileTree: null, sourcePrompt: 'arregla el bug del contador' });
  assert.ok(!p2.includes('PLAYBOOK APLICABLE'));
});

test('safeFileTree: grown project → ranked map; small starter → flat tree', async () => {
  const al = require('../src/services/codex/agent-loop');
  const grown = {};
  for (let i = 0; i < 8; i++) grown[`src/m${i}.tsx`] = `export function M${i}() {}`;
  const runnerGrown = {
    exec: async () => ({ exitCode: 0, stdout: Object.keys(grown).join('\n') }),
    readFile: async (_p, path) => ({ content: grown[path] ?? null }),
  };
  const mapTree = await al.safeFileTree(runnerGrown, 'p1');
  assert.match(mapTree, /Mapa del repositorio/);

  const runnerSmall = { exec: async () => ({ exitCode: 0, stdout: 'src/App.tsx\nsrc/main.tsx' }) };
  const flat = await al.safeFileTree(runnerSmall, 'p1');
  assert.equal(flat, 'src/App.tsx\nsrc/main.tsx');
});

test('safeProjectNotes: reads .sira/notes.md bounded, empty when missing', async () => {
  const al = require('../src/services/codex/agent-loop');
  const withNotes = { readFile: async (_p, path) => ({ content: path === '.sira/notes.md' ? `- decisión\n${'x'.repeat(5000)}` : null }) };
  const notes = await al.safeProjectNotes(withNotes, 'p1');
  assert.match(notes, /^- decisión/);
  assert.ok(notes.length <= 2500);
  const without = { readFile: async () => { throw new Error('not found'); } };
  assert.equal(await al.safeProjectNotes(without, 'p1'), '');
});

test('buildSystemPrompt injects project memory and its upkeep instruction', () => {
  const { buildSystemPrompt } = require('../src/services/codex/agent-loop');
  const p = buildSystemPrompt({ project: { name: 'X' }, plan: null, fileTree: '', sourcePrompt: 'mejora el hero', projectNotes: '- Paleta: verde salvia' });
  assert.match(p, /MEMORIA DEL PROYECTO/);
  assert.match(p, /verde salvia/);
  assert.match(p, /actualiza \.sira\/notes\.md/);
  const p2 = buildSystemPrompt({ project: { name: 'X' }, plan: null, fileTree: '', sourcePrompt: 'x', projectNotes: '' });
  assert.ok(!p2.includes('MEMORIA DEL PROYECTO'));
});

// ── Biblioteca del usuario (skills persistidas) en use_skill ─────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const skillsPersist = require('../src/services/skills-persist');

test('loadUserSkills: lee la Biblioteca del usuario, respeta el tope, ignora colisiones con builtins y nombres inválidos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-user-skills-'));
  skillsPersist.persistUserSkill({ userId: 'u1', name: 'estilo-marca', description: 'Tokens y voz de la marca', body: '# Marca\n'.padEnd(300, 'x'), root });
  skillsPersist.persistUserSkill({ userId: 'u1', name: 'landing-profesional', description: 'colisiona con builtin', body: 'y'.repeat(300), root });
  skillsPersist.persistUserSkill({ userId: 'u2', name: 'ajeno', description: 'de otro usuario', body: 'z'.repeat(300), root });
  const mine = skills.loadUserSkills({ userId: 'u1', root });
  assert.deepEqual(mine.map((s) => s.name), ['estilo-marca'], 'la colisión con builtin se descarta; el skill de u2 no aparece');
  assert.equal(mine[0].source, 'biblioteca');
  assert.equal(mine[0].description, 'Tokens y voz de la marca');
  assert.equal(skills.loadUserSkills({ userId: '', root }).length, 0);
  assert.equal(skills.loadUserSkills({ userId: 'nadie', root }).length, 0);
  for (let i = 0; i < skills.MAX_USER_SKILLS + 3; i += 1) {
    skillsPersist.persistUserSkill({ userId: 'u3', name: `skill-${i}`, description: `n${i}`, body: 'w'.repeat(300), root });
  }
  assert.ok(skills.loadUserSkills({ userId: 'u3', root }).length <= skills.MAX_USER_SKILLS);
  // Un store roto nunca rompe el turno.
  assert.deepEqual(skills.loadUserSkills({ userId: 'u1', persist: { listPersistedSkills: () => { throw new Error('disk'); } } }), []);
});

test('getSkill/formatCatalog: la Biblioteca va después del proyecto y se etiqueta; use_skill la carga con ctx.userId', async () => {
  const ws = [{ name: 'del-proyecto', description: 'workspace', body: 'a'.repeat(300) }];
  const mine = [{ name: 'estilo-marca', description: 'Tokens de marca', body: 'b'.repeat(300), source: 'biblioteca' }];
  assert.equal(skills.getSkill('estilo-marca', ws, mine).source, 'biblioteca');
  assert.equal(skills.getSkill('del-proyecto', ws, mine).name, 'del-proyecto');
  const catalog = skills.formatCatalog(ws, mine);
  assert.match(catalog, /- del-proyecto \(del proyecto\): workspace/);
  assert.match(catalog, /- estilo-marca \(de tu Biblioteca\): Tokens de marca/);
  const names = skills.listSkills(ws, [...mine, { name: 'del-proyecto', description: 'dup', body: '' }]).map((s) => s.name);
  assert.equal(names.filter((n) => n === 'del-proyecto').length, 1, 'sin duplicados entre proyecto y Biblioteca');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-user-skills-tool-'));
  skillsPersist.persistUserSkill({ userId: 'u9', name: 'checklist-qa', description: 'QA antes de entregar', body: '# QA\n'.padEnd(300, 'q'), root });
  const realLoad = skills.loadUserSkills;
  skills.loadUserSkills = (opts) => realLoad({ ...opts, root });
  try {
    const tool = buildTools.getTool('use_skill');
    const runner = { exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }), readFile: async () => { throw new Error('none'); } };
    const loaded = await tool.execute({ name: 'checklist-qa' }, { runner, project: 'p1', userId: 'u9' });
    assert.equal(loaded.isError, false);
    assert.match(loaded.observation, /^# QA/);
    const catalogOut = await tool.execute({}, { runner, project: 'p1', userId: 'u9' });
    assert.match(catalogOut.observation, /checklist-qa \(de tu Biblioteca\)/);
    const other = await tool.execute({}, { runner, project: 'p1', userId: 'someone-else' });
    assert.ok(!other.observation.includes('checklist-qa'), 'la Biblioteca es por usuario');
  } finally {
    skills.loadUserSkills = realLoad;
  }
});
