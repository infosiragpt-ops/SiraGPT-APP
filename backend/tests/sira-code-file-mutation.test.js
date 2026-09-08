'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWorkspace, workspaceRootFor, MAX_FILE_BYTES } = require('../src/services/sira-code/workspace');
const { executeTool } = require('../src/services/sira-code/tools');

async function fixture(t) {
  const workspace = await createWorkspace(`mutation-${crypto.randomBytes(8).toString('hex')}`);
  t.after(() => workspace.destroy());
  return workspace;
}

function session(workspace, permission = 'default') {
  return { agentId: 'construir', workspace, permission };
}

test('conditional mutation rejects stale full bytes without replacing the newer file', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'old');
  const original = await workspace.readFileForMutation('file.txt');
  await workspace.writeFile('file.txt', 'newer');
  await assert.rejects(() => workspace.writeFileIfUnchanged('file.txt', 'replacement', original.bytes), { code: 'file_changed' });
  assert.equal(await workspace.readFile('file.txt'), 'newer');
});

test('same-source concurrent conditional writes have one winner across workspace objects', async (t) => {
  const workspace = await fixture(t);
  const sameWorkspace = await createWorkspace(workspace.root.split('/').pop());
  await workspace.writeFile('file.txt', 'initial');
  const original = await workspace.readFileForMutation('file.txt');
  const results = await Promise.allSettled([
    workspace.writeFileIfUnchanged('file.txt', 'first', original.bytes),
    sameWorkspace.writeFileIfUnchanged('./file.txt', 'second', original.bytes),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'file_changed');
  assert.ok(['first', 'second'].includes(await workspace.readFile('file.txt')));
});

test('two real edit calls do not silently lose an intervening edit', { timeout: 3000 }, async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'A\nB\n');
  const read = workspace.readFileForMutation || (async (rel) => ({ content: await workspace.readFile(rel) }));
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  workspace.readFileForMutation = async (rel) => {
    const snapshot = await read(rel);
    if (++arrived === 2) release();
    await barrier;
    return snapshot;
  };
  const results = await Promise.all([
    executeTool(session(workspace), 'edit', { path: 'file.txt', old_str: 'A', new_str: 'FIRST' }),
    executeTool(session(workspace), 'edit', { path: 'file.txt', old_str: 'B', new_str: 'SECOND' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).code, 'file_changed');
});

test('edit preserves literal replacement dollars and rejects overlapping matches', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'cost');
  const edited = await executeTool(session(workspace), 'edit', { path: 'file.txt', old_str: 'cost', new_str: '$& sale $$ $1' });
  assert.equal(edited.ok, true, edited.error);
  assert.equal(await workspace.readFile('file.txt'), '$& sale $$ $1');
  await workspace.writeFile('file.txt', 'aaa');
  const ambiguous = await executeTool(session(workspace), 'edit', { path: 'file.txt', old_str: 'aa', new_str: 'X' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'edit_ambiguous');
  assert.equal(await workspace.readFile('file.txt'), 'aaa');
});

test('exclusive creates allow one winner and preserve the winning bytes', async (t) => {
  const workspace = await fixture(t);
  const results = await Promise.allSettled([
    workspace.createFile('new.txt', 'first'),
    workspace.createFile('new.txt', 'second'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'file_exists');
  const winningIndex = results.findIndex((result) => result.status === 'fulfilled');
  assert.equal(await workspace.readFile('new.txt'), ['first', 'second'][winningIndex]);
});

test('apply_patch Add does not overwrite an existing file', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('new.txt', 'winner');
  const result = await executeTool(session(workspace), 'apply_patch', { patch: '*** Add File: new.txt\n+replacement' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_exists');
  assert.equal(await workspace.readFile('new.txt'), 'winner');
});

test('move collision changes neither source nor destination', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('source.txt', 'old');
  await workspace.writeFile('dest.txt', 'keep');
  const result = await executeTool(session(workspace), 'apply_patch', { patch: '*** Update File: source.txt\n*** Move to: dest.txt\n-old\n+new' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_exists');
  assert.equal(await workspace.readFile('source.txt'), 'old');
  assert.equal(await workspace.readFile('dest.txt'), 'keep');
});

test('move into a new path preserves the edited bytes and removes its original', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('source.txt', '\uFEFFold\r\n');
  const result = await executeTool(session(workspace), 'apply_patch', { patch: '*** Update File: source.txt\n*** Move to: nested/dest.txt\n-old\n+new' });
  assert.equal(result.ok, true, result.error);
  assert.equal(await workspace.readFile('nested/dest.txt'), '\uFEFFnew\r\n');
  await assert.rejects(() => workspace.readFile('source.txt'), { code: 'ENOENT' });
});

for (const tool of ['edit', 'apply_patch']) {
  test(`${tool} rejects oversized source instead of writing a truncated result`, async (t) => {
    const workspace = await fixture(t);
    const bytes = Buffer.from(`old\n${'x'.repeat(MAX_FILE_BYTES)}`);
    await fs.writeFile(workspace.resolve('large.txt'), bytes);
    const args = tool === 'edit'
      ? { path: 'large.txt', old_str: 'old', new_str: 'new' }
      : { patch: '*** Update File: large.txt\n-old\n+new' };
    const result = await executeTool(session(workspace), tool, args);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'file_too_large');
    assert.deepEqual(await fs.readFile(workspace.resolve('large.txt')), bytes);
  });
}

test('mutation rejects invalid UTF-8 while preserving original bytes', async (t) => {
  const workspace = await fixture(t);
  const bytes = Buffer.from([0x6f, 0x6c, 0x64, 0xff]);
  await fs.writeFile(workspace.resolve('binary.txt'), bytes);
  const result = await executeTool(session(workspace), 'edit', { path: 'binary.txt', old_str: 'old', new_str: 'new' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_encoding');
  assert.deepEqual(await fs.readFile(workspace.resolve('binary.txt')), bytes);
});

test('read-only permissions still reject mutation before the file is changed', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'original');
  const result = await executeTool(session(workspace, 'read'), 'edit', { path: 'file.txt', old_str: 'original', new_str: 'changed' });
  assert.equal(result.ok, false);
  assert.equal(await workspace.readFile('file.txt'), 'original');
});

test('concurrent apply_patch Add has one winner instead of check-then-overwrite', async (t) => {
  const workspace = await fixture(t);
  const results = await Promise.all(['first', 'second'].map((content) => executeTool(session(workspace), 'apply_patch', {
    patch: `*** Add File: new.txt\n+${content}`,
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).code, 'file_exists');
  assert.equal(await workspace.readFile('new.txt'), ['first', 'second'][results.findIndex((result) => result.ok)]);
});

test('partial patch failure reports applied operations and does not imply a transaction', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('keep.txt', 'keep');
  const result = await executeTool(session(workspace), 'apply_patch', {
    patch: '*** Add File: first.txt\n+created\n*** Add File: keep.txt\n+overwrite',
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.operations, ['add first.txt']);
  assert.match(result.content, /Cambios ya aplicados/);
  assert.equal(await workspace.readFile('first.txt'), 'created');
  assert.equal(await workspace.readFile('keep.txt'), 'keep');
});

test('a missing conditional-write source is a conflict, not a recreated file', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'before');
  const original = await workspace.readFileForMutation('file.txt');
  await workspace.removeFile('file.txt');
  await assert.rejects(() => workspace.writeFileIfUnchanged('file.txt', 'after', original.bytes), { code: 'file_changed' });
  await assert.rejects(() => workspace.readFile('file.txt'), { code: 'ENOENT' });
  await workspace.createFile('file.txt', 'subsequent');
  assert.equal(await workspace.readFile('file.txt'), 'subsequent');
});

test('intentional write remains a full replacement without a prior-read requirement', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('file.txt', 'before');
  const result = await executeTool(session(workspace), 'write', { path: 'file.txt', content: 'after' });
  assert.equal(result.ok, true, result.error);
  assert.equal(await workspace.readFile('file.txt'), 'after');
});

test('mutation rejects symlink and hardlink aliases without modifying their target', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('target.txt', 'before');
  await fs.symlink('target.txt', workspace.resolve('alias.txt'));
  const symlink = await executeTool(session(workspace), 'edit', { path: 'alias.txt', old_str: 'before', new_str: 'after' });
  assert.equal(symlink.ok, false);
  assert.equal(symlink.code, 'path_symlink');
  await fs.link(workspace.resolve('target.txt'), workspace.resolve('hard.txt'));
  const hardlink = await executeTool(session(workspace), 'edit', { path: 'hard.txt', old_str: 'before', new_str: 'after' });
  assert.equal(hardlink.ok, false);
  assert.equal(hardlink.code, 'file_links');
  assert.equal(await workspace.readFile('target.txt'), 'before');
});

test('FIFO mutation fails without waiting for a writer (bounded child watchdog)', async (t) => {
  const workspace = await fixture(t);
  const fifo = spawnSync('mkfifo', [workspace.resolve('pipe')], { timeout: 2000, encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.error?.message || fifo.stderr);
  const child = spawnSync(process.execPath, ['-e', `
    const { createWorkspace } = require(${JSON.stringify(path.resolve(__dirname, '../src/services/sira-code/workspace'))});
    const { executeTool } = require(${JSON.stringify(path.resolve(__dirname, '../src/services/sira-code/tools'))});
    (async () => {
      const workspace = await createWorkspace(process.argv[1]);
      const result = await executeTool({agentId:'construir', permission:'default', workspace}, 'edit', {path:'pipe',old_str:'old',new_str:'new'});
      process.stdout.write(JSON.stringify({ok:result.ok,code:result.code}));
    })().catch(() => { process.exitCode = 1; });
  `, path.basename(workspace.root)], { timeout: 3000, encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH, TMPDIR: path.dirname(path.dirname(workspace.root)) } });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { ok: false, code: 'not_a_file' });
});

test('mutation reads wait for a cooperating write but unrelated paths stay independent', { timeout: 3000 }, async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('locked.txt', 'before');
  const originalWrite = fs.writeFile;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  fs.writeFile = async (target, content, options) => {
    if (target === workspace.resolve('locked.txt') && content === 'after') {
      entered();
      await barrier;
    }
    return originalWrite(target, content, options);
  };
  t.after(() => { release(); fs.writeFile = originalWrite; });
  const pendingWrite = workspace.writeFile('locked.txt', 'after');
  await started;
  let readDone = false;
  const pendingRead = workspace.readFileForMutation('locked.txt').then((result) => { readDone = true; return result; });
  await workspace.writeFile('unrelated.txt', 'independent');
  assert.equal(readDone, false);
  release();
  await pendingWrite;
  assert.equal((await pendingRead).content, 'after');
  assert.equal(await workspace.readFile('unrelated.txt'), 'independent');
});

test('case aliases share mutation serialization while case-distinct files keep their own contents', async (t) => {
  const workspace = await fixture(t);
  await workspace.writeFile('case.txt', 'initial');
  let sameFile;
  try {
    const lower = await fs.stat(workspace.resolve('case.txt'));
    const upper = await fs.stat(workspace.resolve('CASE.txt'));
    sameFile = lower.dev === upper.dev && lower.ino === upper.ino;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sameFile = false;
    await workspace.writeFile('CASE.txt', 'initial');
  }
  const expected = Buffer.from('initial');
  const results = await Promise.allSettled([
    workspace.writeFileIfUnchanged('case.txt', 'first', expected),
    workspace.writeFileIfUnchanged('CASE.txt', 'second', expected),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, sameFile ? 1 : 2);
  if (sameFile) {
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'file_changed');
  } else {
    assert.equal(await workspace.readFile('case.txt'), 'first');
    assert.equal(await workspace.readFile('CASE.txt'), 'second');
  }
});

for (const [firstName, secondName] of [['σ.txt', 'ς.txt'], ['s.txt', 'ſ.txt'], ['μ.txt', 'µ.txt']]) {
  test(`filesystem Unicode aliases serialize correctly: ${firstName} / ${secondName}`, async (t) => {
    const workspace = await fixture(t);
    await workspace.writeFile(firstName, 'initial');
    const firstStat = await fs.stat(workspace.resolve(firstName));
    let secondStat;
    try {
      secondStat = await fs.stat(workspace.resolve(secondName));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await workspace.writeFile(secondName, 'initial');
      secondStat = await fs.stat(workspace.resolve(secondName));
    }
    const alias = firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
    const expected = Buffer.from('initial');
    const results = await Promise.allSettled([
      workspace.writeFileIfUnchanged(firstName, 'first', expected),
      workspace.writeFileIfUnchanged(secondName, 'second', expected),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, alias ? 1 : 2);
    if (alias) {
      assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'file_changed');
    } else {
      assert.equal(await workspace.readFile(firstName), 'first');
      assert.equal(await workspace.readFile(secondName), 'second');
    }
  });
}

test('workspace creation refuses a symlink root without changing its target', async (t) => {
  const target = await fixture(t);
  await target.writeFile('keep.txt', 'untouched');
  const aliasId = `mutation-alias-${crypto.randomBytes(8).toString('hex')}`;
  const aliasPath = workspaceRootFor(aliasId);
  await fs.symlink(target.root, aliasPath);
  t.after(() => fs.unlink(aliasPath));
  await assert.rejects(() => createWorkspace(aliasId), { code: 'path_symlink' });
  assert.equal(await target.readFile('keep.txt'), 'untouched');
});

test('conditional mutation requires full byte snapshots and can edit an empty source', async (t) => {
  const workspace = await fixture(t);
  await workspace.createFile('empty.txt', '');
  await assert.rejects(() => workspace.writeFileIfUnchanged('empty.txt', 'bad', ''), { code: 'invalid_snapshot' });
  assert.equal(await workspace.readFile('empty.txt'), '');
  const snapshot = await workspace.readFileForMutation('empty.txt');
  await workspace.writeFileIfUnchanged('empty.txt', '你好 — á', snapshot.bytes);
  assert.equal(await workspace.readFile('empty.txt'), '你好 — á');
});
