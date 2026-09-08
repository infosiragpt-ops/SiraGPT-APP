'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const biblioteca = require('../src/services/agents/hermes-biblioteca');
const hygiene = require('../src/services/agents/hermes-skill-hygiene');
const curator = require('../src/services/agents/hermes-skill-curator');
const diskPersistence = require('../src/services/cowork-disk-persistence');

const USER_A = 'rev-user-a';
const USER_B = 'rev-user-b';

function skillMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Playbook ${name}\n---\n\nPasos cortos para ${name}. Owner-scoped.\n${extra}`;
}

const memoria = new Map();
let nextAsset = 1;

function memorySave(payload) {
  const owner = String(payload.ownerUserId || '');
  const text = Buffer.from(payload.base64 || '', 'base64').toString('utf8');
  const item = {
    id: `rev-${nextAsset++}`,
    filename: payload.filename,
    type: payload.category || 'document',
    brand_label: payload.brandLabel || null,
    kind: payload.kind || null,
    ownerUserId: owner,
    body: text,
    downloadUrl: `/api/agent/artifact/${owner}/${payload.filename}`,
  };
  const list = memoria.get(owner) || [];
  list.push(item);
  memoria.set(owner, list);
  return item;
}

function memoryList(userId) {
  return [...(memoria.get(String(userId)) || [])];
}

function resetAll() {
  curator.resetForTests();
  curator.clearUser(USER_A);
  curator.clearUser(USER_B);
  hygiene.resetForTests();
  biblioteca.resetForTests();
  biblioteca.clearUser(USER_A);
  biblioteca.clearUser(USER_B);
  memoria.clear();
  nextAsset = 1;
}

before(resetAll);
after(resetAll);

describe('hermes biblioteca — Spanish errors', { concurrency: 1 }, () => {
  before(resetAll);

  test('deposit refuses missing userId in Spanish', () => {
    const out = biblioteca.deposit({ userId: '', title: 'x', body: 'hola', save: memorySave });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'Falta el userId.');
    assert.equal(memoria.size, 0);
  });

  test('deposit refuses empty body in Spanish', () => {
    const out = biblioteca.deposit({ userId: USER_A, title: 'x', body: '   ', save: memorySave });
    assert.equal(out.ok, false);
    assert.match(out.error, /cuerpo no puede estar vacío/i);
  });

  test('deposit refuses oversized body in Spanish', () => {
    const out = biblioteca.deposit({
      userId: USER_A,
      title: 'huge',
      body: 'x'.repeat(biblioteca.MAX_BODY_CHARS + 1),
      save: memorySave,
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /excede/);
  });

  test('restoreByHash refuses missing userId in Spanish', () => {
    const out = biblioteca.restoreByHash('', 'abc123abc123');
    assert.equal(out.ok, false);
    assert.equal(out.error, 'Falta el userId.');
  });

  test('restoreByHash refuses missing hash in Spanish', () => {
    const out = biblioteca.restoreByHash(USER_A, '');
    assert.equal(out.ok, false);
    assert.match(out.error, /Falta el hash/);
  });

  test('restoreByHash unknown hash is Spanish and does not leak', () => {
    const out = biblioteca.restoreByHash(USER_A, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(out.ok, false);
    assert.match(out.error, /No hay revisión con hash/);
    assert.ok(!out.error.includes('OpenRouter'));
  });
});

describe('hermes biblioteca — revision ledger', { concurrency: 1 }, () => {
  before(resetAll);

  test('first depositRevision is revision 1 with SiraGPT brand', () => {
    const body = skillMd('daily-notes', 'v1');
    const hash = hygiene.hashSkillBody(body);
    const out = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'daily-notes',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'daily-notes', body, uses: 4 }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    assert.equal(out.ok, true);
    assert.equal(out.revision, 1);
    assert.equal(out.priorKept, false);
    assert.equal(out.brand_label, 'SiraGPT');
    assert.equal(out.userId, USER_A);
    assert.match(out.filename, /skill-promote-daily-notes/);
    const stored = memoryList(USER_A).find((item) => item.id === out.asset_id);
    assert.ok(stored.body.includes(`hash: ${hash}`));
    assert.ok(stored.body.includes('procedencia: skill de usuario'));
    assert.ok(!stored.body.includes('NousResearch'));
    assert.ok(!stored.body.includes('sk-'));
  });

  test('same hash skips a second deposit and keeps the prior asset', () => {
    const body = skillMd('echo-notes');
    const hash = hygiene.hashSkillBody(body);
    const first = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'echo-notes',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'echo-notes', body }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    const before = memoryList(USER_A).filter((item) => item.filename.includes('echo-notes')).length;
    const second = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'echo-notes',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'echo-notes', body }, userId: USER_A, hash, revision: 2 }),
      save: memorySave,
    });
    assert.equal(second.alreadyPromoted, true);
    assert.match(second.message, /ya estaba en Biblioteca/);
    assert.equal(second.asset_id, first.asset_id);
    assert.equal(memoryList(USER_A).filter((item) => item.filename.includes('echo-notes')).length, before);
  });

  test('different hash keeps the prior revision and increments', () => {
    const v1 = skillMd('brief', 'v1');
    const v2 = skillMd('brief', 'v2-nueva');
    const h1 = hygiene.hashSkillBody(v1);
    const h2 = hygiene.hashSkillBody(v2);
    const first = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'brief',
      hash: h1,
      body: hygiene.renderProvenance({ skill: { name: 'brief', body: v1 }, userId: USER_A, hash: h1, revision: 1 }),
      save: memorySave,
    });
    const second = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'brief',
      hash: h2,
      prevHash: h1,
      priorAssetId: first.asset_id,
      merged: true,
      body: hygiene.renderProvenance({
        skill: { name: 'brief', body: v2 },
        userId: USER_A,
        hash: h2,
        prevHash: h1,
        merged: true,
        revision: 2,
        priorKept: true,
      }),
      save: memorySave,
    });
    assert.equal(second.ok, true);
    assert.equal(second.revision, 2);
    assert.equal(second.priorKept, true);
    assert.match(second.message, /conservó la revisión previa/);
    const listed = biblioteca.listRevisions(USER_A, 'brief');
    assert.equal(listed.length, 2);
    assert.ok(listed.some((row) => row.hash === h1 && row.assetId === first.asset_id));
    assert.ok(listed.some((row) => row.hash === h2 && row.current));
    assert.equal(listed.filter((row) => row.hash === h1)[0].current, false);
  });

  test('listRevisions is empty for an unknown skill', () => {
    assert.deepEqual(biblioteca.listRevisions(USER_A, 'no-existe'), []);
  });

  test('user B cannot list or restore user A revisions', () => {
    const body = skillMd('private-notes');
    const hash = hygiene.hashSkillBody(body);
    const deposited = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'private-notes',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'private-notes', body }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    assert.equal(deposited.ok, true);
    assert.equal(biblioteca.listRevisions(USER_B, 'private-notes').length, 0);
    const stolen = biblioteca.restoreByHash(USER_B, hash, { list: memoryList });
    assert.equal(stolen.ok, false);
    assert.match(stolen.error, /No hay revisión/);
    assert.equal(
      biblioteca.listForUser(USER_B, { list: memoryList }).some((item) => item.id === deposited.asset_id),
      false,
    );
  });

  test('getRevisionByHash finds a stored revision and prefix', () => {
    const body = skillMd('prefix-notes');
    const hash = hygiene.hashSkillBody(body);
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'prefix-notes',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'prefix-notes', body }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    const full = biblioteca.getRevisionByHash(USER_A, hash);
    assert.equal(full.ok, true);
    assert.equal(full.skillName, 'prefix-notes');
    const prefix = biblioteca.getRevisionByHash(USER_A, hash.slice(0, 12));
    assert.equal(prefix.ok, true);
    assert.equal(prefix.hash, hash);
  });

  test('ambiguous prefix is reported in Spanish', () => {
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
    const b = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02';
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'amb-a',
      hash: a,
      body: hygiene.renderProvenance({ skill: { name: 'amb-a', body: 'A' }, userId: USER_A, hash: a, revision: 1 }),
      save: memorySave,
    });
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'amb-b',
      hash: b,
      body: hygiene.renderProvenance({ skill: { name: 'amb-b', body: 'B' }, userId: USER_A, hash: b, revision: 1 }),
      save: memorySave,
    });
    const out = biblioteca.getRevisionByHash(USER_A, 'aaaaaaaaaaaa');
    assert.equal(out.ok, false);
    assert.match(out.error, /coincide con varias revisiones/);
  });

  test('depositRevision refuses missing skill name in Spanish', () => {
    const out = biblioteca.depositRevision({
      userId: USER_A,
      hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      body: 'x',
      save: memorySave,
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /Falta el nombre/);
  });
});

describe('hermes biblioteca — restore by hash', { concurrency: 1 }, () => {
  before(resetAll);

  test('restoreByHash points current back at the prior revision', () => {
    const v1 = skillMd('timeline', 'uno');
    const v2 = skillMd('timeline', 'dos');
    const h1 = hygiene.hashSkillBody(v1);
    const h2 = hygiene.hashSkillBody(v2);
    const first = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'timeline',
      hash: h1,
      body: hygiene.renderProvenance({ skill: { name: 'timeline', body: v1 }, userId: USER_A, hash: h1, revision: 1 }),
      save: memorySave,
    });
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'timeline',
      hash: h2,
      prevHash: h1,
      priorAssetId: first.asset_id,
      body: hygiene.renderProvenance({
        skill: { name: 'timeline', body: v2 },
        userId: USER_A,
        hash: h2,
        prevHash: h1,
        revision: 2,
        priorKept: true,
      }),
      save: memorySave,
    });
    const restored = biblioteca.restoreByHash(USER_A, h1, { list: memoryList });
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, true);
    assert.equal(restored.hash, h1);
    assert.equal(restored.skillName, 'timeline');
    assert.match(restored.message, /Restaurada timeline/);
    assert.match(restored.skillBody, /Pasos cortos para timeline/);
    assert.match(restored.skillBody, /uno/);
    assert.ok(!restored.skillBody.includes('dos'));
    const listed = biblioteca.listRevisions(USER_A, 'timeline');
    assert.equal(listed.find((row) => row.hash === h1).current, true);
    assert.equal(listed.find((row) => row.hash === h2).current, false);
    assert.equal(listed.length, 2);
  });

  test('restore of the current revision is a Spanish no-op', () => {
    const body = skillMd('current-only');
    const hash = hygiene.hashSkillBody(body);
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'current-only',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'current-only', body }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    const out = biblioteca.restoreByHash(USER_A, hash, { list: memoryList });
    assert.equal(out.ok, true);
    assert.equal(out.alreadyCurrent, true);
    assert.match(out.message, /ya está en esa revisión/);
  });

  test('dry-run restore does not flip the current pointer', () => {
    const v1 = skillMd('dry-notes', 'old');
    const v2 = skillMd('dry-notes', 'new');
    const h1 = hygiene.hashSkillBody(v1);
    const h2 = hygiene.hashSkillBody(v2);
    const first = biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'dry-notes',
      hash: h1,
      body: hygiene.renderProvenance({ skill: { name: 'dry-notes', body: v1 }, userId: USER_A, hash: h1, revision: 1 }),
      save: memorySave,
    });
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'dry-notes',
      hash: h2,
      prevHash: h1,
      priorAssetId: first.asset_id,
      body: hygiene.renderProvenance({ skill: { name: 'dry-notes', body: v2 }, userId: USER_A, hash: h2, revision: 2, priorKept: true }),
      save: memorySave,
    });
    const preview = biblioteca.restoreByHash(USER_A, h1, { list: memoryList, dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.restored, undefined);
    const listed = biblioteca.listRevisions(USER_A, 'dry-notes');
    assert.equal(listed.find((row) => row.hash === h2).current, true);
  });

  test('extractSkillBodyFromProvenance round-trips the skill body', () => {
    const raw = skillMd('extract-me', 'cuerpo-real');
    const hash = hygiene.hashSkillBody(raw);
    const markdown = hygiene.renderProvenance({
      skill: { name: 'extract-me', body: raw, uses: 3 },
      userId: USER_A,
      hash,
      revision: 1,
    });
    const extracted = biblioteca.extractSkillBodyFromProvenance(markdown);
    assert.match(extracted, /cuerpo-real/);
    assert.ok(!extracted.includes('procedencia:'));
    const meta = biblioteca.parseProvenanceMeta(markdown);
    assert.equal(meta.name, 'extract-me');
    assert.equal(meta.hash, hash);
    assert.equal(meta.revision, 1);
  });

  test('hydrateFromArtifacts rebuilds the ledger from deposited bodies', () => {
    biblioteca.resetForTests();
    const body = skillMd('hydrated');
    const hash = hygiene.hashSkillBody(body);
    const markdown = hygiene.renderProvenance({
      skill: { name: 'hydrated', body },
      userId: USER_A,
      hash,
      revision: 1,
    });
    memorySave({
      ownerUserId: USER_A,
      filename: 'skill-promote-hydrated.md',
      base64: Buffer.from(markdown, 'utf8').toString('base64'),
      brandLabel: 'SiraGPT',
      kind: 'plan',
      category: 'document',
    });
    const ledger = biblioteca.hydrateFromArtifacts(USER_A, { list: memoryList });
    assert.ok(ledger.skills.hydrated);
    assert.equal(ledger.skills.hydrated.revisions[0].hash, hash);
  });
});

describe('hermes hygiene — promote keeps prior and restore writes', { concurrency: 1 }, () => {
  before(resetAll);

  test('promoteSkill second hash keeps the first Biblioteca artifact', () => {
    const v1 = { name: 'journal', body: skillMd('journal', 'alpha'), uses: 5, source: 'user' };
    const v2 = { name: 'journal', body: skillMd('journal', 'beta'), uses: 6, source: 'user' };
    const first = hygiene.promoteSkill(USER_A, v1, { save: memorySave, remember: false });
    const second = hygiene.promoteSkill(USER_A, v2, {
      save: memorySave,
      remember: false,
      promotedState: { journal: { hash: first.hash, assetId: first.asset_id } },
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.merged, true);
    assert.equal(second.priorKept, true);
    assert.equal(second.revision, 2);
    const listed = biblioteca.listRevisions(USER_A, 'journal');
    assert.equal(listed.length, 2);
    assert.ok(memoryList(USER_A).some((item) => item.id === first.asset_id));
    assert.ok(memoryList(USER_A).some((item) => item.id === second.asset_id));
  });

  test('restorePromotedRevision writes the prior skill body via inject', () => {
    const v1 = { name: 'restore-me', body: skillMd('restore-me', 'viejo'), uses: 4, source: 'user' };
    const v2 = { name: 'restore-me', body: skillMd('restore-me', 'nuevo'), uses: 5, source: 'user' };
    const first = hygiene.promoteSkill(USER_A, v1, { save: memorySave, remember: false });
    hygiene.promoteSkill(USER_A, v2, {
      save: memorySave,
      remember: false,
      promotedState: { 'restore-me': { hash: first.hash, assetId: first.asset_id } },
    });
    let written = null;
    const out = hygiene.restorePromotedRevision(USER_A, first.hash, {
      list: memoryList,
      writeSkill: (name, raw) => {
        written = { name, raw };
        return { ok: true };
      },
    });
    assert.equal(out.ok, true);
    assert.match(out.message, /Restaurada restore-me/);
    assert.equal(written.name, 'restore-me');
    assert.match(written.raw, /viejo/);
    assert.ok(!written.raw.includes('nuevo'));
  });

  test('hygiene restore missing hash is Spanish', () => {
    const out = hygiene.restorePromotedRevision(USER_A, '');
    assert.equal(out.ok, false);
    assert.equal(out.message, 'Falta el hash de la revisión.');
  });

  test('curator rememberPromote keeps revision history and restore updates current', () => {
    const v1 = skillMd('curated', 'r1');
    const v2 = skillMd('curated', 'r2');
    curator.recordUse(USER_A, 'curated');
    curator.recordUse(USER_A, 'curated');
    curator.recordUse(USER_A, 'curated');
    const first = curator.promoteHighSignal(USER_A, {
      skillName: 'curated',
      dryRun: false,
      save: memorySave,
      list: memoryList,
      listSkills: () => [{
        name: 'curated',
        description: 'Playbook curated',
        source: 'user',
        readonly: false,
        body: v1,
      }],
      readSkill: () => v1,
    });
    const firstHash = first.promoted[0].hash;
    const firstAsset = first.promoted[0].asset_id;
    curator.promoteHighSignal(USER_A, {
      skillName: 'curated',
      dryRun: false,
      save: memorySave,
      list: memoryList,
      listSkills: () => [{
        name: 'curated',
        description: 'Playbook curated',
        source: 'user',
        readonly: false,
        body: v2,
      }],
      readSkill: () => v2,
    });
    const status = curator.status(USER_A);
    assert.equal(status.hygiene.versioning, true);
    assert.equal(status.hygiene.restoreByHash, true);
    assert.ok(status.promoted.includes('curated'));
    assert.ok(status.promotedRevisions.curated.count >= 2);
    const listed = curator.listRevisions(USER_A, 'curated');
    assert.ok(listed.revisions.length >= 2);
    const restored = curator.restoreRevision(USER_A, firstHash, { list: memoryList, write: false });
    assert.equal(restored.ok, true);
    assert.equal(restored.hash, firstHash);
    assert.equal(restored.asset_id, firstAsset);
    assert.match(restored.skillBody, /r1/);
  });

  test('revision ledger persists and reloads from disk', () => {
    const body = skillMd('durable');
    const hash = hygiene.hashSkillBody(body);
    biblioteca.depositRevision({
      userId: USER_A,
      skillName: 'durable',
      hash,
      body: hygiene.renderProvenance({ skill: { name: 'durable', body }, userId: USER_A, hash, revision: 1 }),
      save: memorySave,
    });
    const saved = diskPersistence.loadSkillRevisions(USER_A);
    assert.ok(saved.skills.durable);
    assert.equal(saved.skills.durable.revisions[0].hash, hash);
    biblioteca.resetForTests();
    diskPersistence.saveSkillRevisions(USER_A, saved);
    const found = biblioteca.getRevisionByHash(USER_A, hash);
    assert.equal(found.ok, true);
    assert.equal(found.skillName, 'durable');
  });

  test('playbook map curator strategy mentions restore-by-hash', () => {
    const { FOLDER_CAPABILITY_MAP } = require('../src/services/agents/hermes-playbook-bridge');
    const row = FOLDER_CAPABILITY_MAP.find((entry) => entry.hermes === 'curator');
    assert.match(row.strategy, /restore-by-hash/);
    assert.match(row.sira, /hermes-biblioteca/);
  });
});

describe('hermes biblioteca — writeSkill on restore uses FS stub', { concurrency: 1 }, () => {
  before(resetAll);

  test('writeSkillRaw and restore do not touch a real skills home', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-rev-fs-'));
    const files = new Map();
    const fsStub = {
      mkdirSync() { return undefined; },
      writeFileSync(p, data) { files.set(p, String(data)); },
      readFileSync(p) {
        if (!files.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p);
      },
    };
    const v1 = skillMd('fs-notes', 'primera');
    const v2 = skillMd('fs-notes', 'segunda');
    const first = hygiene.promoteSkill(USER_A, { name: 'fs-notes', body: v1, uses: 4, source: 'user' }, {
      save: memorySave,
      remember: false,
    });
    hygiene.promoteSkill(USER_A, { name: 'fs-notes', body: v2, uses: 5, source: 'user' }, {
      save: memorySave,
      remember: false,
      promotedState: { 'fs-notes': { hash: first.hash, assetId: first.asset_id } },
    });
    const out = hygiene.restorePromotedRevision(USER_A, first.hash, {
      list: memoryList,
      fs: fsStub,
      skillsHome: tmp,
    });
    assert.equal(out.ok, true);
    const dest = path.join(tmp, USER_A, 'fs-notes', 'SKILL.md');
    assert.equal(files.has(dest), true);
    assert.match(files.get(dest), /primera/);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
