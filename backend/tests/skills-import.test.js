'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const skillsImport = require('../src/services/skills-import');
const chatSkills = require('../src/services/chat-skills');
const persist = require('../src/services/skills-persist');

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const dnsOk = async () => PUBLIC;
const ENV = { CLAWHUB_URL: 'https://clawhub.ai', CLAWHUB_TOKEN: 'hub-secret-token' };

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-skills-import-'));
}

function response(body, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const hdrs = new Map(Object.entries({ 'content-type': contentType, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k) => hdrs.get(String(k).toLowerCase()) || null },
    body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(buf) })), cancel: () => {} }; }, cancel: async () => {} },
    arrayBuffer: async () => buf,
  };
}

function skillZip(folder, markdown) {
  const zip = new PizZip();
  zip.file(`${folder}/SKILL.md`, markdown);
  zip.file(`${folder}/README.md`, 'readme');
  zip.file('__MACOSX/._SKILL.md', 'junk');
  return zip.generate({ type: 'nodebuffer' });
}

const SKILL_MD = '---\nname: postgres-backups\ndescription: Copias de seguridad de PostgreSQL\n---\n# Postgres backups\n\nUsa pg_dump con --format=custom.';

function hubFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, headers: init && init.headers ? { ...init.headers } : {} });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url.startsWith(match) : match.test(url)) return typeof handler === 'function' ? handler(url, init) : handler;
    }
    return response({ error: 'not found' }, { status: 404 });
  };
}

test('classifySource: ClawHub slugs/pages, GitHub refs/URLs, raw URLs; rejects the rest', () => {
  assert.deepEqual(skillsImport.classifySource('clawhub:postgres-backups'), { kind: 'clawhub', ref: 'postgres-backups', slug: 'postgres-backups' });
  assert.deepEqual(skillsImport.classifySource('postgres-backups'), { kind: 'clawhub', ref: 'postgres-backups', slug: 'postgres-backups' });
  assert.deepEqual(skillsImport.classifySource('https://clawhub.ai/skills/Postgres-Backups'), { kind: 'clawhub', ref: 'postgres-backups', slug: 'postgres-backups' });
  assert.deepEqual(skillsImport.classifySource('github:acme/skills/postgres@main'), { kind: 'github', ref: 'github:acme/skills/postgres@main', owner: 'acme', repo: 'skills', path: 'postgres', gitRef: 'main', file: null });
  assert.deepEqual(skillsImport.classifySource('acme/skills'), { kind: 'github', ref: 'acme/skills', owner: 'acme', repo: 'skills', path: '', gitRef: null, file: null });
  const tree = skillsImport.classifySource('https://github.com/acme/skills/tree/v2/skills/postgres');
  assert.deepEqual([tree.kind, tree.owner, tree.repo, tree.gitRef, tree.path, tree.file], ['github', 'acme', 'skills', 'v2', 'skills/postgres', null]);
  const blob = skillsImport.classifySource('https://github.com/acme/skills/blob/main/postgres/SKILL.md');
  assert.deepEqual([blob.path, blob.file], ['postgres', 'postgres/SKILL.md']);
  assert.equal(skillsImport.classifySource('https://example.com/skills/pack.zip').kind, 'url');
  assert.equal(skillsImport.classifySource('https://example.com/x/SKILL.md').kind, 'url');
  for (const bad of ['', 'https://example.com/page', 'clawhub:Bad Slug', 'https://clawhub.ai/pricing', '???', 'a'.repeat(501)]) {
    assert.throws(() => skillsImport.classifySource(bad), (e) => e.name === 'SkillImportError' && e.status === 400, JSON.stringify(bad));
  }
});

test('ClawHub: verify → install → archive download → SKILL.md saved with provenance (token only to the hub origin)', async () => {
  const root = tmpRoot();
  const calls = [];
  const fetchImpl = hubFetch([
    ['https://clawhub.ai/api/v1/skills/postgres-backups/verify', response({ ok: true, decision: 'pass', reasons: [], displayName: 'Postgres Backups', publisherHandle: 'acme' })],
    ['https://clawhub.ai/api/v1/skills/postgres-backups/install', response({ ok: true, slug: 'postgres-backups', installKind: 'archive', archive: { version: '1.2.0', downloadUrl: 'https://cdn.clawhub.example/archives/postgres-backups-1.2.0.zip' } })],
    ['https://cdn.clawhub.example/archives/postgres-backups-1.2.0.zip', response(skillZip('postgres-backups', SKILL_MD), { contentType: 'application/zip' })],
  ], calls);
  const out = await skillsImport.importSkill({ userId: 'u1', source: 'clawhub:postgres-backups', root, env: ENV, fetchImpl, dnsCheck: dnsOk, now: new Date('2026-10-09T20:00:00Z') });
  assert.equal(out.skill.name, 'postgres-backups');
  assert.match(out.skill.body, /pg_dump/);
  assert.equal(out.replaced, false);
  assert.equal(out.provenance.source, 'clawhub');
  assert.equal(out.provenance.version, '1.2.0');
  assert.equal(out.provenance.via, 'clawhub');
  assert.equal(out.provenance.publisher, 'acme');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.authorization, 'Bearer hub-secret-token', 'hub API calls carry the token');
  assert.equal(calls[2].headers.authorization, undefined, 'a CDN on another origin never sees the token');
  const loaded = chatSkills.loadChatSkill({ userId: 'u1', name: 'postgres-backups', root });
  assert.ok(loaded && /pg_dump/.test(loaded.body));
  const state = persist.readSkillState({ userId: 'u1', root });
  assert.equal(state.imports['postgres-backups'].source, 'clawhub');
  assert.equal(state.imports['postgres-backups'].version, '1.2.0');
  assert.equal(state.imports['postgres-backups'].importedAt, '2026-10-09T20:00:00.000Z');
  assert.match(state.imports['postgres-backups'].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(skillsImport.listImports({ userId: 'u1', root })), ['postgres-backups']);

  // Re-importing updates in place without an explicit overwrite.
  const again = await skillsImport.importSkill({ userId: 'u1', source: 'postgres-backups', root, env: ENV, fetchImpl, dnsCheck: dnsOk });
  assert.equal(again.replaced, true);
  assert.equal(skillsImport.forgetImport({ userId: 'u1', name: 'postgres-backups', root }), true);
  assert.deepEqual(skillsImport.listImports({ userId: 'u1', root }), {});
});

test('ClawHub: a failing security verdict or a blocked install stops before any download', async () => {
  const root = tmpRoot();
  const calls = [];
  const failing = hubFetch([
    ['https://clawhub.ai/api/v1/skills/evil/verify', response({ ok: false, decision: 'fail', reasons: ['Prompt injection detected', 'Publisher suspended'] })],
  ], calls);
  await assert.rejects(
    skillsImport.importSkill({ userId: 'u1', source: 'evil', root, env: ENV, fetchImpl: failing, dnsCheck: dnsOk }),
    (e) => e.code === 'skill_blocked' && e.status === 409 && /Prompt injection detected; Publisher suspended/.test(e.message),
  );
  assert.equal(calls.length, 1, 'no install/download after a failing verdict');
  const blocked = hubFetch([
    ['https://clawhub.ai/api/v1/skills/gone/verify', response({}, { status: 404 })],
    ['https://clawhub.ai/api/v1/skills/gone/install', response({ ok: false, slug: 'gone', reason: 'quarantined', message: 'This skill is quarantined pending review', status: 423 }, { status: 423 })],
  ]);
  await assert.rejects(
    skillsImport.importSkill({ userId: 'u1', source: 'gone', root, env: ENV, fetchImpl: blocked, dnsCheck: dnsOk }),
    (e) => e.code === 'skill_blocked' && /quarantined pending review/.test(e.message),
  );
  const missing = hubFetch([]);
  await assert.rejects(
    skillsImport.importSkill({ userId: 'u1', source: 'nope', root, env: ENV, fetchImpl: missing, dnsCheck: dnsOk }),
    (e) => e.code === 'skill_not_found' && e.status === 404,
  );
});

test('ClawHub: a commit-pinned GitHub install resolution fetches the raw SKILL.md at that commit', async () => {
  const root = tmpRoot();
  const calls = [];
  const fetchImpl = hubFetch([
    ['https://clawhub.ai/api/v1/skills/notion-sync/verify', response({ ok: true, decision: 'pass', displayName: 'Notion Sync' })],
    ['https://clawhub.ai/api/v1/skills/notion-sync/install', response({ ok: true, slug: 'notion-sync', installKind: 'github', github: { repo: 'acme/skills', path: 'skills/notion-sync', commit: 'abcdef1234567890', contentHash: 'x', sourceUrl: 'https://github.com/acme/skills/tree/abcdef1234567890/skills/notion-sync' } })],
    ['https://raw.githubusercontent.com/acme/skills/abcdef1234567890/skills/notion-sync/SKILL.md', response('---\nname: notion-sync\n---\nSync pages.', { contentType: 'text/plain' })],
  ], calls);
  const out = await skillsImport.importSkill({ userId: 'u1', source: 'notion-sync', root, env: { CLAWHUB_URL: 'https://clawhub.ai' }, fetchImpl, dnsCheck: dnsOk });
  assert.equal(out.skill.name, 'notion-sync');
  assert.equal(out.provenance.version, 'abcdef123456');
  assert.equal(out.provenance.via, 'clawhub+github');
  assert.equal(calls[2].headers.authorization, undefined, 'no GitHub token configured → none sent');
  const noCommit = hubFetch([
    ['https://clawhub.ai/api/v1/skills/x/verify', response({}, { status: 404 })],
    ['https://clawhub.ai/api/v1/skills/x/install', response({ ok: true, slug: 'x', installKind: 'github', github: { repo: 'acme/skills', path: 'x', commit: 'main' } })],
  ]);
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'x', root, env: ENV, fetchImpl: noCommit, dnsCheck: dnsOk }), (e) => e.code === 'skill_source_invalid');
});

test('GitHub refs resolve to raw.githubusercontent.com; HTML pages are rejected; a reserved name gets a suffix', async () => {
  const root = tmpRoot();
  const calls = [];
  const fetchImpl = hubFetch([
    ['https://raw.githubusercontent.com/acme/skills/main/postgres/SKILL.md', response('---\nname: pdf\ndescription: Lector PDF\n---\nInstrucciones', { contentType: 'text/plain; charset=utf-8' })],
    ['https://raw.githubusercontent.com/acme/skills/HEAD/SKILL.md', response('<!doctype html><html><body>login</body></html>', { contentType: 'text/html' })],
  ], calls);
  const out = await skillsImport.importSkill({ userId: 'u1', source: 'github:acme/skills/postgres@main', root, env: { GITHUB_TOKEN: 'gh-token' }, fetchImpl, dnsCheck: dnsOk });
  assert.equal(out.skill.name, 'pdf-importada', 'built-in «pdf» is never shadowed');
  assert.equal(out.renamed, 'pdf');
  assert.equal(out.provenance.version, 'main');
  assert.equal(out.provenance.url, 'https://github.com/acme/skills/tree/main/postgres');
  assert.equal(calls[0].headers.authorization, 'token gh-token');
  await assert.rejects(
    skillsImport.importSkill({ userId: 'u1', source: 'acme/skills', root, env: {}, fetchImpl, dnsCheck: dnsOk }),
    (e) => e.code === 'skill_not_markdown',
  );
  const explicit = await skillsImport.importSkill({ userId: 'u1', source: 'github:acme/skills/postgres@main', name: 'Mi-PDF', root, env: {}, fetchImpl, dnsCheck: dnsOk });
  assert.equal(explicit.skill.name, 'mi-pdf');
});

test('URL sources: a SKILL.md or a .zip; SSRF posture — private hosts, IP literals, redirects into metadata and private DNS are rejected', async () => {
  const root = tmpRoot();
  const zipBuf = skillZip('weekly-report', '---\nname: weekly-report\n---\nInforme semanal.');
  const fetchImpl = hubFetch([
    ['https://example.com/skills/weekly.zip', response(zipBuf, { contentType: 'application/zip' })],
    ['https://example.com/skills/plain/SKILL.md', response('---\nname: plain-skill\n---\nPlano.', { contentType: 'text/markdown' })],
    ['https://example.com/jump.md', response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data.md' } })],
    ['https://example.com/hop.md', response('', { status: 302, headers: { location: 'https://example.org/final/SKILL.md' } })],
    ['https://example.org/final/SKILL.md', response('---\nname: hopped\n---\nOk.', { contentType: 'text/plain' })],
  ]);
  const z = await skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/skills/weekly.zip', root, env: {}, fetchImpl, dnsCheck: dnsOk });
  assert.equal(z.skill.name, 'weekly-report');
  const md = await skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/skills/plain/SKILL.md', root, env: {}, fetchImpl, dnsCheck: dnsOk });
  assert.equal(md.skill.name, 'plain-skill');
  const hopped = await skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/hop.md', root, env: {}, fetchImpl, dnsCheck: dnsOk });
  assert.equal(hopped.skill.name, 'hopped', 'public → public redirects are followed');
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'http://10.0.0.5/SKILL.md', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'web_fetch_blocked_host');
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'http://localhost/SKILL.md', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'web_fetch_blocked_host');
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/jump.md', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'web_fetch_blocked_host');
  const privateDns = async () => { const e = new Error('resolves to private'); e.code = 'web_fetch_blocked_host'; throw e; };
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/skills/plain/SKILL.md', root, env: {}, fetchImpl, dnsCheck: privateDns }), (e) => e.code === 'web_fetch_blocked_host');
});

test('size caps and archives without SKILL.md fail cleanly; disabled flag short-circuits', async () => {
  const root = tmpRoot();
  const huge = 'x'.repeat(skillsImport.MAX_MARKDOWN_BYTES + 10);
  const emptyZip = new PizZip(); emptyZip.file('readme.txt', 'nothing');
  const fetchImpl = hubFetch([
    ['https://example.com/huge/SKILL.md', response(huge, { contentType: 'text/plain' })],
    ['https://example.com/empty.zip', response(emptyZip.generate({ type: 'nodebuffer' }), { contentType: 'application/zip' })],
    ['https://example.com/notzip.zip', response('this is not a zip', { contentType: 'application/zip' })],
  ]);
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/huge/SKILL.md', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'skill_too_large' && e.status === 413);
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/empty.zip', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'skill_archive_no_skill_md');
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/notzip.zip', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'skill_archive_invalid');
  await assert.rejects(skillsImport.importSkill({ userId: 'u1', source: 'postgres-backups', root, env: { SIRAGPT_SKILL_IMPORT_DISABLED: '1' }, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'skill_import_disabled' && e.status === 503);
  await assert.rejects(skillsImport.importSkill({ userId: '', source: 'postgres-backups', root, env: {}, fetchImpl, dnsCheck: dnsOk }), (e) => e.code === 'auth_required');
  assert.equal(skillsImport.maxArchiveBytes({ SIRAGPT_SKILL_IMPORT_MAX_BYTES: '1048576' }), 1048576);
  assert.equal(skillsImport.maxArchiveBytes({ SIRAGPT_SKILL_IMPORT_MAX_BYTES: '10' }), skillsImport.DEFAULT_MAX_ARCHIVE_BYTES, 'absurd caps fall back');
});

test('an own skill with the same name is not silently replaced', async () => {
  const root = tmpRoot();
  chatSkills.createUserSkill({ userId: 'u1', name: 'plain-skill', description: 'mía', body: 'Mi versión', root });
  const fetchImpl = hubFetch([
    ['https://example.com/skills/plain/SKILL.md', response('---\nname: plain-skill\n---\nAjena.', { contentType: 'text/markdown' })],
  ]);
  await assert.rejects(
    skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/skills/plain/SKILL.md', root, env: {}, fetchImpl, dnsCheck: dnsOk }),
    (e) => e.code === 'name_taken' && e.status === 409 && /overwrite: true/.test(e.message),
  );
  const forced = await skillsImport.importSkill({ userId: 'u1', source: 'https://example.com/skills/plain/SKILL.md', overwrite: true, root, env: {}, fetchImpl, dnsCheck: dnsOk });
  assert.equal(forced.replaced, true);
  assert.match(chatSkills.loadChatSkill({ userId: 'u1', name: 'plain-skill', root }).body, /Ajena/);
});

test('searchMarketplace normalises ClawHub rows, honours the limit, and reports an unavailable hub', async () => {
  const fetchImpl = hubFetch([
    [/^https:\/\/clawhub\.ai\/api\/v1\/search\?/, (url) => {
      const u = new URL(url);
      assert.equal(u.searchParams.get('q'), 'postgres');
      assert.equal(u.searchParams.get('limit'), '2');
      return response({ results: [
        { slug: 'postgres-backups', displayName: 'Postgres Backups', summary: 'Copias', publisher: { handle: 'acme' }, official: true, install: { kind: 'clawhub', reference: 'postgres-backups' }, metrics: { installs: 1200 } },
        { slug: 'Bad Slug!', displayName: 'nope' },
        { slug: 'pg-tune', summary: 'Tuning', source: 'skills-sh', install: { kind: 'github', reference: 'acme/pg-tune' } },
        { slug: 'extra', summary: 'beyond the limit' },
      ] });
    }],
  ]);
  const out = await skillsImport.searchMarketplace('postgres', { limit: 2, env: ENV, fetchImpl, dnsCheck: dnsOk });
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], { slug: 'postgres-backups', name: 'Postgres Backups', summary: 'Copias', publisher: 'acme', official: true, source: 'clawhub', installRef: 'clawhub:postgres-backups', url: 'https://clawhub.ai/skills/postgres-backups', installs: 1200 });
  assert.equal(out.results[1].source, 'github');
  assert.equal(out.results[1].installRef, 'clawhub:pg-tune');
  assert.deepEqual((await skillsImport.searchMarketplace('   ', { env: ENV, fetchImpl, dnsCheck: dnsOk })).results, []);
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(skillsImport.searchMarketplace('postgres', { env: ENV, fetchImpl: down, dnsCheck: dnsOk }), (e) => e.code === 'marketplace_unavailable' && e.status === 502 && !/ECONNRESET/.test(e.message));
  assert.equal(skillsImport.hubBaseUrl({ CLAWHUB_URL: 'ftp://nope' }), 'https://clawhub.ai');
  assert.equal(skillsImport.hubBaseUrl({ CLAWHUB_URL: 'https://hub.internal.example/' }), 'https://hub.internal.example');
});

test('skills state keeps import provenance (bounded, validated) alongside installed/disabled/removed', () => {
  const state = persist.normalizeSkillState({
    installed: { 'skill-creator': '2026-01-01T00:00:00.000Z' },
    disabled: ['foo'],
    imports: {
      'postgres-backups': { source: 'clawhub', ref: 'postgres-backups', version: '1.2.0', importedAt: '2026-10-09T20:00:00.000Z', sha256: 'abc', bogus: { nested: true }, url: 'x'.repeat(1000) },
      'Bad Name': { source: 'url' },
      empty: {},
      junk: 'string',
    },
  });
  assert.deepEqual(Object.keys(state.imports), ['postgres-backups']);
  assert.equal(state.imports['postgres-backups'].bogus, undefined);
  assert.equal(state.imports['postgres-backups'].url.length, 400);
  assert.equal(persist.normalizeSkillState(null).imports, undefined, 'legacy shape when nothing was imported');
});
