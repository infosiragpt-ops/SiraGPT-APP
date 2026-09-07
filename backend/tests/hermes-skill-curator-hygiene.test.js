'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const curator = require('../src/services/agents/hermes-skill-curator');
const hygiene = require('../src/services/agents/hermes-skill-hygiene');
const biblioteca = require('../src/services/agents/hermes-biblioteca');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');

const USER_A = 'hygiene-user-a';
const USER_B = 'hygiene-user-b';
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

function makeFsStub(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync(p) { return files.has(p); },
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, data) { files.set(p, String(data)); },
    mkdirSync() { return undefined; },
    renameSync(src, dest) {
      if (!files.has(src)) {
        const err = new Error(`ENOENT: ${src}`);
        err.code = 'ENOENT';
        throw err;
      }
      files.set(dest, files.get(src));
      files.delete(src);
    },
  };
}

function skillMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Playbook ${name}\n---\n\nPasos cortos para ${name}. Owner-scoped.\n${extra}`;
}

function listFrom(skills) {
  return () => skills.map((s) => ({
    name: s.name,
    description: s.description || `Playbook ${s.name}`,
    source: 'user',
    readonly: false,
    body: s.body,
  }));
}

const memoria = new Map();
let nextAsset = 1;

function memorySave(payload) {
  const owner = String(payload.ownerUserId || '');
  const text = Buffer.from(payload.base64 || '', 'base64').toString('utf8');
  const item = {
    id: `hyg-${nextAsset++}`,
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

before(() => {
  curator.resetForTests();
  curator.clearUser(USER_A);
  curator.clearUser(USER_B);
  hygiene.resetForTests();
  memoria.clear();
  nextAsset = 1;
});

after(() => {
  curator.clearUser(USER_A);
  curator.clearUser(USER_B);
  curator.resetForTests();
  hygiene.resetForTests();
  memoria.clear();
});

function resetAll() {
  curator.resetForTests();
  curator.clearUser(USER_A);
  curator.clearUser(USER_B);
  hygiene.resetForTests();
  memoria.clear();
  nextAsset = 1;
}

describe('hermes skill hygiene — hash and name', { concurrency: 1 }, () => {
  before(resetAll);
  test('hashSkillBody is deterministic and ignores trailing whitespace', () => {
    const a = hygiene.hashSkillBody('hola mundo  \n');
    const b = hygiene.hashSkillBody('hola mundo');
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test('different bodies produce different hashes', () => {
    assert.notEqual(hygiene.hashSkillBody('alpha'), hygiene.hashSkillBody('beta'));
  });

  test('canonicalSkillName collapses copy/version suffixes', () => {
    assert.equal(hygiene.canonicalSkillName('notes-2'), 'notes');
    assert.equal(hygiene.canonicalSkillName('notes_copy'), 'notes');
    assert.equal(hygiene.canonicalSkillName('notes-v2'), 'notes');
    assert.notEqual(hygiene.canonicalSkillName('old-notes'), 'keep-me');
  });

  test('detectDuplicates groups exact content hashes', () => {
    const body = skillMd('notes');
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'notes', body, source: 'user', uses: 4 },
      { name: 'notes-2', body, source: 'user', uses: 1 },
    ]);
    assert.ok(duplicates.some((d) => d.kind === 'hash' && d.names.includes('notes') && d.names.includes('notes-2')));
    assert.match(duplicates.find((d) => d.kind === 'hash').message, /Duplicado por hash/);
  });

  test('detectDuplicates groups name variants with different hashes', () => {
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'notes', body: skillMd('notes', 'A'), source: 'user', uses: 2 },
      { name: 'notes-copy', body: skillMd('notes-copy', 'B'), source: 'user', uses: 1 },
    ]);
    assert.ok(duplicates.some((d) => d.kind === 'name'));
    assert.match(duplicates.find((d) => d.kind === 'name').message, /Duplicado por nombre/);
  });

  test('unrelated names are not grouped', () => {
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'alpha', body: skillMd('alpha'), source: 'user' },
      { name: 'omega', body: skillMd('omega', 'otro'), source: 'user' },
    ]);
    assert.equal(duplicates.length, 0);
  });
});

describe('hermes skill hygiene — merge proposals', { concurrency: 1 }, () => {
  before(resetAll);
  test('proposeMerge keeps the skill with more uses', () => {
    const body = skillMd('notes');
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'notes', body, source: 'user', uses: 5 },
      { name: 'notes-2', body, source: 'user', uses: 1 },
    ]);
    const proposed = hygiene.proposeMerge(duplicates[0]);
    assert.equal(proposed.proposal.keep, 'notes');
    assert.deepEqual(proposed.proposal.archive, ['notes-2']);
    assert.match(proposed.proposal.message, /conservar notes/);
  });

  test('proposeMerge prefers pinned over unpinned', () => {
    const body = skillMd('wiki');
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'wiki', body, source: 'user', uses: 9, pinned: false },
      { name: 'wiki-2', body, source: 'user', uses: 1, pinned: true },
    ]);
    const proposed = hygiene.proposeMerge(duplicates[0]);
    assert.equal(proposed.proposal.keep, 'wiki-2');
    assert.deepEqual(proposed.proposal.archive, ['wiki']);
  });

  test('pinned loser is not archived', () => {
    const body = skillMd('keep');
    const { duplicates } = hygiene.detectDuplicates([
      { name: 'keep', body, source: 'user', uses: 8, pinned: true },
      { name: 'keep-2', body, source: 'user', uses: 1, pinned: true },
    ]);
    const proposed = hygiene.proposeMerge(duplicates[0]);
    assert.deepEqual(proposed.proposal.archive, []);
    assert.ok(proposed.proposal.skipped.includes('keep-2'));
  });
});

describe('hermes skill hygiene — caps and rate limits', { concurrency: 1 }, () => {
  before(resetAll);
  test('checkCaps reports skill and body ceilings in Spanish', () => {
    const over = hygiene.checkCaps({ skillCount: 40, bodyChars: 20_000 }, { skillCap: 40 });
    assert.equal(over.ok, false);
    assert.ok(over.messages.some((m) => m.includes('Tope de skills')));
    assert.ok(over.messages.some((m) => m.includes('Cuerpo excede')));
  });

  test('checkCaps reports memory ceiling', () => {
    const over = hygiene.checkCaps({ memoryUsed: 2200 });
    assert.equal(over.overMemoryCap, true);
    assert.match(over.messages.join(' '), /Tope de memoria/);
  });

  test('allowWrite rate-limits the 9th write in the window', () => {
    hygiene.resetForTests();
    const id = 'rate-user';
    for (let i = 0; i < 8; i += 1) {
      const ok = hygiene.allowWrite(id, { now: T0 + i, writeLimit: 8, writeWindowMs: 60_000 });
      assert.equal(ok.allowed, true, `write ${i + 1} should pass`);
    }
    const blocked = hygiene.allowWrite(id, { now: T0 + 20, writeLimit: 8, writeWindowMs: 60_000 });
    assert.equal(blocked.allowed, false);
    assert.match(blocked.message, /Escritura limitada/);
  });

  test('allowWrite resets after the window', () => {
    hygiene.resetForTests();
    const id = 'rate-user-2';
    hygiene.allowWrite(id, { now: T0, writeLimit: 1, writeWindowMs: 1000 });
    const later = hygiene.allowWrite(id, { now: T0 + 1001, writeLimit: 1, writeWindowMs: 1000 });
    assert.equal(later.allowed, true);
  });

  test('missing userId never writes', () => {
    const blocked = hygiene.allowWrite('', { now: T0 });
    assert.equal(blocked.allowed, false);
    assert.equal(hygiene.promoteSkill('', { name: 'x', body: 'y', uses: 9 }).ok, false);
    assert.equal(curator.dedupe('').ok, false);
    assert.equal(memoria.size, 0);
  });
});

describe('hermes skill hygiene — promote with provenance', { concurrency: 1 }, () => {
  before(resetAll);
  test('high-signal by uses >= 3', () => {
    assert.equal(hygiene.isHighSignal({ uses: 3, status: 'active' }), true);
    assert.equal(hygiene.isHighSignal({ uses: 2, status: 'active' }), false);
  });

  test('pinned with one use is high-signal; archived is not', () => {
    assert.equal(hygiene.isHighSignal({ uses: 1, pinned: true, status: 'pinned' }), true);
    assert.equal(hygiene.isHighSignal({ uses: 9, status: 'archived' }), false);
  });

  test('promote writes Biblioteca with provenance and SiraGPT brand', () => {
    const out = hygiene.promoteSkill(USER_A, {
      name: 'daily-notes',
      body: skillMd('daily-notes'),
      uses: 5,
      source: 'user',
    }, { save: memorySave, remember: false });
    assert.equal(out.ok, true);
    assert.equal(out.brand_label, 'SiraGPT');
    assert.equal(out.userId, USER_A);
    assert.match(out.message, /Promovido a Biblioteca/);
    assert.match(out.biblioteca.filename, /skill-promote-daily-notes/);
    const stored = memoryList(USER_A).find((item) => item.id === out.asset_id);
    assert.ok(stored.body.includes(`hash: ${out.hash}`));
    assert.ok(stored.body.includes('procedencia: skill de usuario'));
    assert.ok(!stored.body.includes('OpenRouter'));
    assert.ok(!stored.body.includes('sk-'));
  });

  test('same hash skips a second deposit (conflict no-op)', () => {
    const skill = { name: 'echo-notes', body: skillMd('echo-notes'), uses: 6, source: 'user' };
    const first = hygiene.promoteSkill(USER_A, skill, {
      save: memorySave,
      remember: false,
      promotedState: {},
    });
    const before = memoryList(USER_A).filter((item) => item.filename.includes('echo-notes')).length;
    const second = hygiene.promoteSkill(USER_A, skill, {
      save: memorySave,
      remember: false,
      promotedState: { 'echo-notes': { hash: first.hash, assetId: first.asset_id } },
    });
    assert.equal(second.alreadyPromoted, true);
    assert.match(second.message, /ya estaba en Biblioteca/);
    assert.equal(memoryList(USER_A).filter((item) => item.filename.includes('echo-notes')).length, before);
  });

  test('same name different hash merges provenance', () => {
    const older = hygiene.hashSkillBody(skillMd('brief', 'v1'));
    const out = hygiene.promoteSkill(USER_A, {
      name: 'brief',
      body: skillMd('brief', 'v2-nueva'),
      uses: 4,
      source: 'user',
    }, {
      save: memorySave,
      remember: false,
      promotedState: { brief: { hash: older, assetId: 'hyg-old' } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.merged, true);
    assert.match(out.message, /Conflicto fusionado/);
    assert.ok(memoryList(USER_A).some((item) => item.body.includes('hash_previo:')));
  });

  test('user B cannot see user A promotions', () => {
    const deposited = hygiene.promoteSkill(USER_A, {
      name: 'private-notes',
      body: skillMd('private-notes'),
      uses: 4,
      source: 'user',
    }, { save: memorySave, remember: false });
    assert.equal(deposited.ok, true);
    const mine = biblioteca.listForUser(USER_A, { list: memoryList });
    const foreign = biblioteca.listForUser(USER_B, { list: memoryList });
    assert.ok(mine.some((item) => item.id === deposited.asset_id));
    assert.equal(foreign.some((item) => item.id === deposited.asset_id), false);
  });

  test('secret-looking body is not promoted', () => {
    const out = hygiene.promoteSkill(USER_A, {
      name: 'leaky',
      body: skillMd('leaky', 'token=sk-abcdefghijklmnopqrstuvwxyz012345'),
      uses: 9,
      source: 'user',
    }, { save: memorySave, remember: false });
    assert.equal(out.ok, false);
    assert.match(out.message, /secreto o dato sensible/);
  });

  test('body over skill cap is refused', () => {
    const out = hygiene.promoteSkill(USER_A, {
      name: 'huge',
      body: skillMd('huge', 'x'.repeat(20_000)),
      uses: 9,
      source: 'user',
    }, { save: memorySave, remember: false, skillChars: 16_000 });
    assert.equal(out.ok, false);
    assert.match(out.message, /Cuerpo excede/);
  });

  test('memory cap blocks the optional remember note', () => {
    const curatedMemory = {
      add() { throw new Error('should not add'); },
    };
    const out = hygiene.promoteSkill(USER_A, {
      name: 'memo',
      body: skillMd('memo'),
      uses: 4,
      source: 'user',
    }, {
      save: memorySave,
      remember: true,
      curatedMemory,
      memoryUsed: 2200,
    });
    assert.equal(out.ok, true);
    assert.equal(out.memoryNote.ok, false);
    assert.match(out.memoryNote.message, /Tope de memoria/);
  });
});

describe('hermes skill curator — injected FS stubs', { concurrency: 1 }, () => {
  before(resetAll);
  test('dedupe dry-run proposes archive without renaming', () => {
    const body = skillMd('notes');
    const fsStub = makeFsStub({
      '/tmp/skills/hygiene-user-a/notes/SKILL.md': body,
      '/tmp/skills/hygiene-user-a/notes-2/SKILL.md': body,
    });
    curator.recordUse(USER_A, 'notes', { now: T0 });
    curator.recordUse(USER_A, 'notes', { now: T0 });
    curator.recordUse(USER_A, 'notes-2', { now: T0 });
    const out = curator.dedupe(USER_A, {
      now: T0,
      dryRun: true,
      skillsHome: '/tmp/skills',
      fs: fsStub,
      listSkills: listFrom([
        { name: 'notes', body },
        { name: 'notes-2', body },
      ]),
      readSkill: (name) => (name === 'notes-2' ? body : body),
      deposit: false,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.ok(out.mergeProposals.some((p) => p.keep === 'notes' && p.archive.includes('notes-2')));
    assert.ok(fsStub.existsSync('/tmp/skills/hygiene-user-a/notes-2/SKILL.md'));
    assert.match(out.messages.join('\n'), /Propuesta: conservar/);
  });

  test('dedupe apply archives the loser via the FS stub', () => {
    const body = skillMd('notes');
    const src = '/tmp/skills/hygiene-user-a/notes-2';
    const dest = '/tmp/skills/hygiene-user-a/.archive/notes-2';
    const fsStub = makeFsStub({
      [src]: body,
    });
    hygiene.resetForTests();
    const out = curator.dedupe(USER_A, {
      now: T0 + 10,
      dryRun: false,
      skillsHome: '/tmp/skills',
      fs: fsStub,
      listSkills: listFrom([
        { name: 'notes', body, },
        { name: 'notes-2', body },
      ]),
      readSkill: () => body,
    });
    curator.recordUse(USER_A, 'notes', { now: T0 });
    curator.recordUse(USER_A, 'notes', { now: T0 });
    assert.equal(out.ok, true);
    assert.ok(out.archived.some((row) => row.name === 'notes-2' && row.ok));
    assert.equal(fsStub.existsSync(src), false);
    assert.equal(fsStub.existsSync(dest), true);
  });

  test('forced run with promote deposits owner-scoped report and skill', () => {
    const body = skillMd('daily-notes', 'alta señal');
    curator.recordUse(USER_A, 'daily-notes', { now: T0 });
    curator.recordUse(USER_A, 'daily-notes', { now: T0 });
    curator.recordUse(USER_A, 'daily-notes', { now: T0 });
    const out = curator.run(USER_A, {
      now: T0 + 1000,
      dryRun: true,
      force: true,
      promote: true,
      save: memorySave,
      list: memoryList,
      listSkills: listFrom([{ name: 'daily-notes', body }]),
      readSkill: () => body,
      fs: makeFsStub(),
    });
    assert.equal(out.ok, true);
    assert.equal(out.biblioteca.ok, true);
    assert.equal(out.biblioteca.brand_label, 'SiraGPT');
    assert.match(out.report, /Higiene \(duplicados y promoción\)/);
    assert.ok(out.promoteCandidates.some((row) => row.name === 'daily-notes'));
    assert.equal(
      biblioteca.listForUser(USER_B, { list: memoryList }).some((item) => item.id === out.biblioteca.asset_id),
      false,
    );
  });

  test('skill_curator tool exposes dedupe and promote', async () => {
    const tool = buildHermesTools().find((item) => item.name === 'skill_curator');
    assert.ok(tool.parameters.properties.action.enum.includes('dedupe'));
    assert.ok(tool.parameters.properties.action.enum.includes('promote'));
    const denied = await tool.execute({ action: 'dedupe' }, {});
    assert.equal(denied.ok, false);
    const status = await tool.execute({ action: 'status' }, { userId: USER_A });
    assert.equal(status.neverDeletes, true);
    assert.deepEqual(status.hygiene.dedupeBy, ['hash', 'name']);
  });

  test('optional-skills inventory stays reference-only in growth', () => {
    const growth = curator.growthCandidates({
      matrix: {
        skills: [
          { upstream: 'siyuan', folder: 'optional-skills/productivity/siyuan', description: 'notes library', status: 'reference-only' },
          { upstream: 'flash-attention', folder: 'optional-skills/mlops/flash', description: 'gpu', status: 'reference-only' },
        ],
      },
    });
    assert.ok(growth.some((g) => g.upstream === 'siyuan'));
    assert.ok(growth[0].note.includes('do not dump'));
  });

  test('readSkill stub is used instead of real fs', () => {
    let reads = 0;
    const body = skillMd('stubbed');
    const inspected = hygiene.inspectHygiene(USER_A, [
      { name: 'stubbed', source: 'user', uses: 1 },
    ], {
      readSkill: (name) => {
        reads += 1;
        assert.equal(name, 'stubbed');
        return body;
      },
      fs: {
        readFileSync() { throw new Error('real fs should not run'); },
      },
    });
    assert.equal(inspected.ok, true);
    assert.ok(reads >= 1);
    assert.equal(inspected.fingerprints[0].contentHash, hygiene.hashSkillBody(body));
  });
});
