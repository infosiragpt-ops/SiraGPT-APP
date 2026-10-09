'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { buildSearchSkillsMarketplaceTool, buildInstallSkillTool } = require('../src/services/agent-harness/tools/skills-marketplace-tools');
const { SkillImportError } = require('../src/services/skills-import');
const { createChatSkillsRouter } = require('../src/routes/chat-skills');
const chatSkills = require('../src/services/chat-skills');
const { buildRouteTestApp } = require('./http-test-utils');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const RESULT = { slug: 'postgres-backups', name: 'Postgres Backups', summary: 'Copias de seguridad', publisher: 'acme', official: true, source: 'clawhub', installRef: 'clawhub:postgres-backups', url: 'https://clawhub.ai/skills/postgres-backups', installs: 1200 };

function fakeImport(calls = []) {
  return {
    calls,
    searchMarketplace: async (query, opts) => {
      calls.push(['search', query, opts]);
      if (query === 'down') throw new SkillImportError('marketplace_unavailable', 'ClawHub no está disponible ahora.', 502);
      return { query, results: query === 'nothing' ? [] : [RESULT, { ...RESULT, slug: 'pg-tune', name: 'pg-tune', installRef: 'clawhub:pg-tune', official: false, publisher: null, installs: undefined, summary: '' }], source: 'https://clawhub.ai' };
    },
    importSkill: async (input) => {
      calls.push(['import', input]);
      if (input.source === 'evil') throw new SkillImportError('skill_blocked', 'ClawHub marca «evil» como no segura: malware.', 409, { reasons: ['malware'] });
      if (input.source === 'taken' && !input.overwrite) throw new SkillImportError('name_taken', 'Ya tienes una skill llamada «taken». Repite con overwrite: true para reemplazarla, o indica otro nombre.', 409);
      return {
        skill: { name: input.name || 'postgres-backups', title: 'postgres-backups', body: '# x', source: 'biblioteca' },
        provenance: { source: 'clawhub', ref: input.source, url: 'https://clawhub.ai/skills/postgres-backups', version: '1.2.0', sha256: 'abc', importedAt: '2026-10-09T20:00:00.000Z', via: 'clawhub', publisher: 'acme' },
        replaced: Boolean(input.overwrite),
        renamed: input.source === 'pdf' ? 'pdf' : null,
      };
    },
    listImports: () => ({ 'postgres-backups': { source: 'clawhub', ref: 'postgres-backups', version: '1.2.0', importedAt: '2026-10-09T20:00:00.000Z' } }),
    forgetImport: (input) => { calls.push(['forget', input]); return true; },
  };
}

test('search_skills_marketplace: auto tier, relays results with installRef, handles empty and unavailable', async () => {
  const tool = buildSearchSkillsMarketplaceTool();
  assert.equal(tool.name, 'search_skills_marketplace');
  assert.equal(tool.permissionTier, 'auto');
  assert.ok(!tool.inputSchema.safeParse({ query: 'x', extra: 1 }).success);
  const skillsImport = fakeImport();
  const out = await tool.execute({ query: 'postgres' }, { userId: 'u1', skillsImport });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.match(out.summary, /1\. Postgres Backups \(clawhub:postgres-backups\) — Copias de seguridad \[oficial · por acme · 1200 instalaciones\]/);
  assert.match(out.summary, /install_skill\(\{ source: "<installRef>" \}\)/);
  assert.deepEqual(skillsImport.calls[0], ['search', 'postgres', { limit: 8 }]);
  const none = await tool.execute({ query: 'nothing' }, { skillsImport });
  assert.equal(none.count, 0);
  assert.match(none.summary, /No encontré skills/);
  const down = await tool.execute({ query: 'down' }, { skillsImport });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'marketplace_unavailable');
});

test('install_skill: confirm tier, user-scoped, relays provenance, renames and structured errors', async () => {
  const tool = buildInstallSkillTool();
  assert.equal(tool.name, 'install_skill');
  assert.equal(tool.permissionTier, 'confirm');
  assert.match(tool.humanDescription({ source: 'clawhub:postgres-backups' }), /Instalar la skill «clawhub:postgres-backups»/);
  const skillsImport = fakeImport();
  assert.equal((await tool.execute({ source: 'x' }, { skillsImport })).code, 'auth_required');
  const out = await tool.execute({ source: 'clawhub:postgres-backups' }, { userId: 'u1', skillsImport });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'postgres-backups');
  assert.deepEqual(skillsImport.calls.at(-1)[1], { userId: 'u1', source: 'clawhub:postgres-backups', name: null, overwrite: false });
  assert.match(out.summary, /instalada desde ClawHub \(versión 1\.2\.0\)/);
  assert.match(out.summary, /use_skill/);
  const renamed = await tool.execute({ source: 'pdf', name: 'pdf-importada' }, { userId: 'u1', skillsImport });
  assert.match(renamed.summary, /se guardó como «pdf-importada» porque «pdf» es una skill integrada/);
  const blocked = await tool.execute({ source: 'evil' }, { userId: 'u1', skillsImport });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'skill_blocked');
  assert.deepEqual(blocked.details, { reasons: ['malware'] });
  const taken = await tool.execute({ source: 'taken' }, { userId: 'u1', skillsImport });
  assert.equal(taken.code, 'name_taken');
  assert.match(taken.hint, /overwrite: true/);
  const forced = await tool.execute({ source: 'taken', overwrite: true }, { userId: 'u1', skillsImport });
  assert.equal(forced.replaced, true);
});

test('harness registers both tools, the loop labels them, the policy line teaches them and the selector keeps them on skill turns', () => {
  const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
  const names = buildHarnessTools(new Set()).map((d) => d.name);
  assert.ok(names.includes('install_skill') && names.includes('search_skills_marketplace'));
  const loop = read('src/services/agentic-chat-stream.js');
  assert.match(loop, /search_skills_marketplace: \['buscar skills en el marketplace'/);
  assert.match(loop, /install_skill: \['instalar una skill'/);
  assert.match(loop, /busca con `search_skills_marketplace` y, solo cuando lo pida, instala con `install_skill`/);
  const { selectTools } = require('../src/services/agents/tool-selector');
  const tools = ['web_search', 'read_url', 'use_skill', 'install_skill', 'search_skills_marketplace', ...Array.from({ length: 30 }, (_, i) => `misc_tool_${i}`)].map((name) => ({ name, description: name }));
  for (const q of ['¿hay una skill para hacer backups de postgres?', 'instala esta skill de clawhub', 'busca en el marketplace una habilidad para notion']) {
    const picked = selectTools({ tools, userQuery: q, intent: 'code_generation', maxTools: 6, signals: {} }, { skillAdapter: null });
    assert.ok(picked.selectedNames.includes('install_skill') && picked.selectedNames.includes('search_skills_marketplace'), q);
  }
});

function buildApp({ skillsImport, user = { id: 'u1' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-skills-routes-'));
  const skills = {
    ...chatSkills,
    listChatSkills: (opts) => chatSkills.listChatSkills({ ...opts, root }),
    loadChatSkill: (opts) => chatSkills.loadChatSkill({ ...opts, root }),
    getSkillState: (opts) => chatSkills.getSkillState({ ...opts, root }),
    removeSkill: (opts) => chatSkills.removeSkill({ ...opts, root }),
    createUserSkill: (opts) => chatSkills.createUserSkill({ ...opts, root }),
  };
  const auth = (req, res, next) => { if (!user) return res.status(401).json({ ok: false }); req.user = user; return next(); };
  const router = createChatSkillsRouter({ auth, skills, skillsImport, memorySignal: async () => '' });
  return { app: buildRouteTestApp('/api/skills', router), root, skills };
}

test('POST /api/skills/import installs by reference and maps import errors to their status', async () => {
  const skillsImport = fakeImport();
  const { app } = buildApp({ skillsImport });
  const ok = await request(app).post('/api/skills/import').send({ source: 'clawhub:postgres-backups' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.skill.name, 'postgres-backups');
  assert.equal(ok.body.provenance.version, '1.2.0');
  assert.deepEqual(skillsImport.calls.at(-1)[1], { userId: 'u1', source: 'clawhub:postgres-backups', name: null, overwrite: false });
  const named = await request(app).post('/api/skills/import').send({ source: 'acme/skills', name: 'mi-skill', overwrite: true });
  assert.equal(named.status, 201);
  assert.deepEqual(skillsImport.calls.at(-1)[1], { userId: 'u1', source: 'acme/skills', name: 'mi-skill', overwrite: true });
  const blocked = await request(app).post('/api/skills/import').send({ source: 'evil' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'skill_blocked');
  assert.deepEqual(blocked.body.details, { reasons: ['malware'] });
  const missing = await request(app).post('/api/skills/import').send({});
  assert.equal(missing.status, 400);
  assert.equal((await request(app).post('/api/skills/import').send({ source: 'x'.repeat(600) })).status, 400);
});

test('GET /api/skills/marketplace/search is user-rate-limited and returns normalised results', async () => {
  const skillsImport = fakeImport();
  const { app } = buildApp({ skillsImport });
  const res = await request(app).get('/api/skills/marketplace/search?q=postgres&limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 2);
  assert.equal(res.body.results[0].installRef, 'clawhub:postgres-backups');
  assert.deepEqual(skillsImport.calls.at(-1), ['search', 'postgres', { limit: 5 }]);
  assert.equal((await request(app).get('/api/skills/marketplace/search')).status, 400, 'q is required');
  const down = await request(app).get('/api/skills/marketplace/search?q=down');
  assert.equal(down.status, 502);
  assert.equal(down.body.code, 'marketplace_unavailable');
  let limited = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await request(app).get('/api/skills/marketplace/search?q=postgres');
    if (r.status === 429) { limited = r; break; }
  }
  assert.ok(limited, 'the per-user search limiter kicks in');
  assert.equal(limited.body.code, 'rate_limited');
});

test('GET /api/skills/:name exposes import provenance; DELETE forgets it', async () => {
  const skillsImport = fakeImport();
  const { app, skills } = buildApp({ skillsImport });
  skills.createUserSkill({ userId: 'u1', name: 'postgres-backups', description: 'Copias', body: '# x' });
  const one = await request(app).get('/api/skills/postgres-backups');
  assert.equal(one.status, 200);
  assert.equal(one.body.skill.provenance.source, 'clawhub');
  assert.equal(one.body.skill.provenance.version, '1.2.0');
  const del = await request(app).delete('/api/skills/postgres-backups');
  assert.equal(del.status, 200);
  assert.deepEqual(skillsImport.calls.at(-1), ['forget', { userId: 'u1', name: 'postgres-backups' }]);
});
