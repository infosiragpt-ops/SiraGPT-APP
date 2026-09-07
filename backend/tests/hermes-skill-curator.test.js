'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const curator = require('../src/services/agents/hermes-skill-curator');
const biblioteca = require('../src/services/agents/hermes-biblioteca');
const skillManage = require('../src/services/agent-runner/skills/manage');
const { UPSTREAM_TO_SIRAGPT_SKILLS } = require('../src/services/agents/hermes-playbook-bridge');

const USER_A = 'curator-user-a';
const USER_B = 'curator-user-b';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const skillsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-curator-skills-'));

const memoria = new Map();
let nextAsset = 1;

function memorySave(payload) {
  const owner = String(payload.ownerUserId || '');
  const item = {
    id: `mem-${nextAsset++}`,
    filename: payload.filename,
    type: payload.category || 'document',
    brand_label: payload.brandLabel || null,
    kind: payload.kind || null,
    ownerUserId: owner,
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

function writeUserSkill(userId, name, description) {
  return skillManage.create({
    name,
    description,
    body: `Playbook for ${name}: keep the steps short and owner-scoped.`,
    userId,
    skillsHome,
  });
}

before(() => {
  curator.resetForTests();
  process.env.SIRAGPT_AGENT_SKILLS_HOME = skillsHome;
});

after(() => {
  curator.resetForTests();
  try { fs.rmSync(skillsHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('hermes skill curator — isolation and gates', { concurrency: 1 }, () => {
  test('first run seeds last_run_at and does not archive', () => {
    const created = writeUserSkill(USER_A, 'old-notes', 'Personal notes playbook');
    assert.equal(created.ok, true);
    curator.recordUse(USER_A, 'old-notes', { now: T0 - (100 * DAY) });

    const first = curator.run(USER_A, { now: T0, dryRun: false, skillsHome, deposit: false });
    assert.equal(first.ok, true);
    assert.equal(first.deferred, true);
    assert.equal(first.archived.length, 0);
    assert.ok(fs.existsSync(path.join(skillsHome, USER_A, 'old-notes', 'SKILL.md')));
  });

  test('later dry-run reports archive candidates without moving files', () => {
    const reviewed = curator.run(USER_A, {
      now: T0 + DAY,
      dryRun: true,
      force: true,
      skillsHome,
      deposit: false,
    });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.dryRun, true);
    assert.ok(reviewed.archiveCandidates.some((row) => row.name === 'old-notes'));
    assert.ok(fs.existsSync(path.join(skillsHome, USER_A, 'old-notes', 'SKILL.md')));
  });

  test('pin blocks archive; apply moves only unpinned user skills', () => {
    writeUserSkill(USER_A, 'keep-me', 'Pinned playbook');
    curator.recordUse(USER_A, 'keep-me', { now: T0 - (100 * DAY) });
    curator.pin(USER_A, 'keep-me');

    const applied = curator.run(USER_A, {
      now: T0 + (2 * DAY),
      dryRun: false,
      force: true,
      skillsHome,
      deposit: false,
    });
    assert.equal(applied.ok, true);
    assert.ok(applied.archived.some((row) => row.ok && row.name === 'old-notes'));
    assert.ok(fs.existsSync(path.join(skillsHome, USER_A, '.archive', 'old-notes', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsHome, USER_A, 'keep-me', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(skillsHome, USER_A, 'old-notes', 'SKILL.md')), false);
  });

  test('builtin skills stay readonly', () => {
    assert.equal(typeof skillManage.isBuiltin, 'function');
    const moved = curator.run(USER_A, {
      now: T0 + (3 * DAY),
      dryRun: false,
      force: true,
      skillsHome,
      deposit: false,
    });
    assert.equal(moved.ok, true);
    assert.ok(moved.archived.every((row) => row.name !== 'skill-authoring'));
  });

  test('user B cannot see user A deposits or skills', () => {
    const deposited = biblioteca.deposit({
      userId: USER_A,
      chatId: 'chat-a',
      title: 'curator-report-a',
      body: '# Report A\nPrefiere tablas en markdown.',
      kind: 'plan',
      save: memorySave,
    });
    assert.equal(deposited.ok, true);
    assert.equal(deposited.brand_label, 'SiraGPT');

    const mine = biblioteca.listForUser(USER_A, { list: memoryList });
    assert.ok(mine.some((item) => item.id === deposited.asset_id));
    assert.ok(mine.every((item) => item.type === 'document'));

    const foreign = biblioteca.listForUser(USER_B, { list: memoryList });
    assert.equal(foreign.some((item) => item.id === deposited.asset_id), false);

    writeUserSkill(USER_B, 'b-only', 'User B playbook');
    const reviewB = curator.review(USER_B, { skillsHome, now: T0 });
    assert.ok(reviewB.skills.every((row) => row.name !== 'keep-me'));
    assert.ok(reviewB.skills.some((row) => row.name === 'b-only'));
  });

  test('missing userId never writes', () => {
    const added = biblioteca.deposit({ userId: '', title: 'nope', body: 'should not persist', save: memorySave });
    assert.equal(added.ok, false);
    assert.equal(memoria.size === 0 || !memoria.get(''), true);
    const ran = curator.run('', { force: true });
    assert.equal(ran.ok, false);
  });

  test('forced run deposits an owner-scoped Biblioteca report', () => {
    const out = curator.run(USER_A, {
      now: T0 + (4 * DAY),
      dryRun: true,
      force: true,
      skillsHome,
      save: memorySave,
    });
    assert.equal(out.ok, true);
    assert.equal(out.biblioteca.ok, true);
    assert.equal(out.biblioteca.brand_label, 'SiraGPT');
    assert.equal(out.biblioteca.userId, USER_A);
    assert.match(out.report, /Bundled skills were not touched/);
    assert.equal(
      biblioteca.listForUser(USER_B, { list: memoryList }).some((item) => item.id === out.biblioteca.asset_id),
      false,
    );
  });
});

describe('hermes skill curator — growth + tool', { concurrency: 1 }, () => {
  test('maps document/library Hermes skills onto native SiraGPT playbooks', () => {
    assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['pptx-author'].includes('technical-docs'));
    assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS.qmd.includes('biblioteca-deposit'));
    assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS.siyuan.includes('biblioteca-deposit'));
    assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['openclaw-migration'].includes('openclaw-import-audit'));
  });

  test('growth candidates stay reference-only (no upstream dump)', () => {
    const growth = curator.growthCandidates({
      matrix: {
        skills: [
          { upstream: 'siyuan-notes', folder: 'optional-skills/productivity/siyuan', description: 'notes library', status: 'reference-only' },
          { upstream: 'flash-attention', folder: 'optional-skills/mlops/flash', description: 'gpu kernels', status: 'reference-only' },
          { upstream: 'pptx-author', folder: 'optional-skills/finance/pptx-author', description: 'slides', status: 'covered' },
        ],
      },
    });
    assert.ok(growth.some((g) => g.upstream === 'siyuan-notes'));
    assert.equal(growth.some((g) => g.upstream === 'flash-attention'), false);
    assert.equal(growth.some((g) => g.upstream === 'pptx-author'), false);
    assert.ok(growth[0].note.includes('do not dump'));
  });

  test('skill_curator status is user-scoped and never deletes', () => {
    assert.equal(curator.status('').neverDeletes, true);
    const stA = curator.status(USER_A);
    const stB = curator.status(USER_B);
    assert.equal(stA.pattern, 'hermes-skill-curator');
    assert.ok(stA.pinned.includes('keep-me'));
    assert.equal(stB.pinned.includes('keep-me'), false);
    assert.equal(curator.run('', { force: true }).ok, false);
  });
});
