'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  safeReadEditorFile, safeSaveEditorFile, safeWriteFiles, EDITOR_MAX_BYTES,
} = require('../../scripts/code-runner-fs-helper');
const helperPath = path.resolve(__dirname, '../../scripts/code-runner-fs-helper.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-editor-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function expects(code) { return (error) => error.publicCode === code; }
function helper(root, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, 'save-editor'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', () => { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(file));
  });
}

test('editor reads all 200001 bytes rather than silently discarding the last byte', (t) => {
  const root = setup(t), content = 'a'.repeat(200000) + 'Z';
  fs.writeFileSync(path.join(root, 'large.ts'), content);
  assert.deepEqual(safeReadEditorFile(root, 'large.ts'), { path: 'large.ts', content, revision: hash(content), sizeBytes: 200001, truncated: false, readOnly: false });
});

test('bounded full UTF-8 read preserves the BOM, CRLF and multibyte characters exactly', (t) => {
  const root = setup(t), content = '\uFEFFconst saludo = "Español 👋";\r\n';
  fs.writeFileSync(path.join(root, 'app.ts'), content);
  const read = safeReadEditorFile(root, 'app.ts');
  assert.equal(read.content, content); assert.equal(read.revision, hash(Buffer.from(content)));
  const output = safeSaveEditorFile(root, { path: 'app.ts', content: content + '// siguiente\r\n', expectedRevision: read.revision });
  assert.equal(output.written, 1); assert.equal(output.sizeBytes, Buffer.byteLength(content + '// siguiente\r\n'));
  assert.equal(fs.readFileSync(path.join(root, 'app.ts'), 'utf8'), content + '// siguiente\r\n');
});

test('exact limit is editable; overlimit returns no lossy partial text or writable revision', (t) => {
  const root = setup(t), exact = 'x'.repeat(EDITOR_MAX_BYTES);
  fs.writeFileSync(path.join(root, 'exact.ts'), exact);
  assert.equal(safeReadEditorFile(root, 'exact.ts').revision, hash(exact));
  fs.writeFileSync(path.join(root, 'over.ts'), exact + 'Y');
  assert.deepEqual(safeReadEditorFile(root, 'over.ts'), { path: 'over.ts', content: '', revision: null, sizeBytes: EDITOR_MAX_BYTES + 1, truncated: true, readOnly: true });
  assert.throws(() => safeSaveEditorFile(root, { path: 'over.ts', content: 'shorter', expectedRevision: hash(exact + 'Y') }), expects('file_read_only'));
  assert.throws(() => safeSaveEditorFile(root, { path: 'new.ts', content: exact + 'Y', expectedRevision: null }), expects('file_too_large'));
  assert.equal(fs.readFileSync(path.join(root, 'over.ts'), 'utf8'), exact + 'Y');
  assert.equal(fs.existsSync(path.join(root, 'new.ts')), false);
});

test('CAS preserves unrelated files, executable mode and the winning revision', (t) => {
  const root = setup(t); fs.writeFileSync(path.join(root, 'app.js'), 'old', { mode: 0o755 }); fs.writeFileSync(path.join(root, 'keep.txt'), 'untouched');
  const read = safeReadEditorFile(root, 'app.js');
  const result = safeSaveEditorFile(root, { path: 'app.js', content: 'new', expectedRevision: read.revision });
  assert.equal(result.revision, hash('new')); assert.equal(safeReadEditorFile(root, 'app.js').revision, result.revision);
  assert.throws(() => safeSaveEditorFile(root, { path: 'app.js', content: 'stale', expectedRevision: read.revision }), expects('file_conflict'));
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(root, 'app.js')).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(root).sort(), ['app.js', 'keep.txt']);
});

test('new-file saves require expectedRevision:null and refuse to replace an existing file', (t) => {
  const root = setup(t);
  const result = safeSaveEditorFile(root, { path: 'src/new.ts', content: 'new', expectedRevision: null });
  assert.equal(result.revision, hash('new'));
  assert.throws(() => safeSaveEditorFile(root, { path: 'src/new.ts', content: 'overwrite', expectedRevision: null }), expects('file_conflict'));
  assert.throws(() => safeSaveEditorFile(root, { path: 'src/other.ts', content: 'bad' }), expects('invalid_request'));
  assert.equal(fs.readFileSync(path.join(root, 'src/new.ts'), 'utf8'), 'new');
});

test('two helper processes saving one revision cannot both overwrite it', async (t) => {
  const root = setup(t); fs.writeFileSync(path.join(root, 'app.ts'), 'original');
  const revision = safeReadEditorFile(root, 'app.ts').revision;
  const results = await Promise.all(['first', 'second'].map((content) => helper(root, { path: 'app.ts', content, expectedRevision: revision })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(['file_conflict', 'file_busy'].includes(results.find((r) => !r.ok).error));
  const winner = results.find((r) => r.ok);
  assert.equal(safeReadEditorFile(root, 'app.ts').revision, winner.revision);
  assert.deepEqual(fs.readdirSync(root), ['app.ts']);
});

test('two new-file creators cannot claim success for overwriting each other', async (t) => {
  const root = setup(t);
  const results = await Promise.all(['first', 'second'].map((content) => helper(root, { path: 'new.ts', content, expectedRevision: null })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(['file_conflict', 'file_busy'].includes(results.find((r) => !r.ok).error));
  assert.equal(safeReadEditorFile(root, 'new.ts').revision, results.find((r) => r.ok).revision);
  assert.deepEqual(fs.readdirSync(root), ['new.ts']);
});

test('invalid UTF-8, NUL and a private key never enter an editable document', (t) => {
  const root = setup(t);
  for (const content of [Buffer.from([0xc3, 0x28]), Buffer.from('a\0b')]) {
    fs.writeFileSync(path.join(root, 'data.bin'), content);
    assert.throws(() => safeReadEditorFile(root, 'data.bin'), expects('binary_file'));
  }
  fs.writeFileSync(path.join(root, 'key.txt'), ['-----BEGIN ', 'PRIVATE ', 'KEY-----\nexample\n'].join(''));
  assert.throws(() => safeReadEditorFile(root, 'key.txt'), expects('protected_path'));
  assert.throws(() => safeSaveEditorFile(root, { path: 'nul.ts', content: 'a\0b', expectedRevision: null }), expects('binary_file'));
  assert.throws(() => safeSaveEditorFile(root, { path: 'surrogate.ts', content: '\uD800', expectedRevision: null }), expects('binary_file'));
});

test('editor rejects traversal, secret/internal paths and symlink/hardlink aliases without modifying outside files', (t) => {
  const root = setup(t), outside = setup(t);
  fs.writeFileSync(path.join(outside, 'keep.ts'), 'outside');
  for (const file of ['../escape.ts', '/absolute.ts', 'C:/drive.ts', 'a\0b']) {
    assert.throws(() => safeSaveEditorFile(root, { path: file, content: 'bad', expectedRevision: null }), expects('invalid_request'));
  }
  for (const file of ['.env', 'src/.env.local', '.git/config', 'id_ed25519', 'a/.sira-editor-temp-forged']) {
    assert.throws(() => safeSaveEditorFile(root, { path: file, content: 'bad', expectedRevision: null }), expects('protected_path'));
    assert.throws(() => safeReadEditorFile(root, file), expects('protected_path'));
  }
  fs.symlinkSync(path.join(outside, 'keep.ts'), path.join(root, 'link.ts'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  fs.linkSync(path.join(outside, 'keep.ts'), path.join(root, 'hard.ts'));
  for (const file of ['link.ts', 'linkdir/keep.ts', 'hard.ts']) {
    assert.throws(() => safeReadEditorFile(root, file), expects('unsafe_path'));
    assert.throws(() => safeSaveEditorFile(root, { path: file, content: 'bad', expectedRevision: null }), expects('unsafe_path'));
  }
  assert.equal(fs.readFileSync(path.join(outside, 'keep.ts'), 'utf8'), 'outside');
});

test('legacy imports still report the exact successful count rather than the requested count', (t) => {
  const root = setup(t);
  assert.deepEqual(safeWriteFiles(root, [{ path: 'ok.ts', content: 'ok' }, { path: '../bad.ts', content: 'bad' }]), { written: 1, totalBytes: 2 });
  assert.equal(safeReadEditorFile(root, 'ok.ts').content, 'ok');
});


test('workspace control guard excludes exec and helper writes but leaves other projects independent', async () => {
  const { createWorkspaceMutationGuard } = require('../../scripts/code-runner-utils');
  const guard = createWorkspaceMutationGuard();
  let release;
  const command = guard.run('project-a', () => new Promise((resolve) => { release = resolve; }));
  let wrote = false;
  await assert.rejects(() => guard.run('project-a', async () => { wrote = true; }), (error) => error.code === 'file_busy');
  assert.equal(wrote, false);
  assert.equal(await guard.run('project-b', async () => 'separate'), 'separate');
  release('completed'); assert.equal(await command, 'completed');
  assert.equal(await guard.run('project-a', async () => 'saved'), 'saved');
  await assert.rejects(() => guard.run('project-a', async () => { throw Error('command failed'); }), /command failed/);
  assert.equal(await guard.run('project-a', async () => 'released'), 'released');
});


test('Linux kernel workspace lock releases after its holder is killed, with no persisted marker', { skip: process.platform !== 'linux' }, async (t) => {
  const root = setup(t);
  const lock = spawn('flock', ['--exclusive', root, process.execPath, '-e', "console.log('locked');setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-lock.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { lock.stdout.once('data', resolve); lock.once('error', reject); });
  const blocked = await helper(root, { path: 'app.ts', content: 'blocked', expectedRevision: null });
  assert.equal(blocked.ok, false); assert.equal(blocked.error, 'file_busy'); assert.equal(fs.existsSync(path.join(root, 'app.ts')), false);
  process.kill(-lock.pid, 'SIGKILL');
  await new Promise((resolve) => lock.once('close', resolve));
  const saved = await helper(root, { path: 'app.ts', content: 'after crash', expectedRevision: null });
  assert.equal(saved.ok, true); assert.equal(saved.revision, hash('after crash'));
  assert.deepEqual(fs.readdirSync(root), ['app.ts']);
});


test('Linux lock rejection stays file_busy when the save payload outlives flock stdin', { skip: process.platform !== 'linux' }, async (t) => {
  const root = setup(t);
  const lock = spawn('flock', ['--exclusive', root, process.execPath, '-e', "console.log('locked');setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-lock.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { lock.stdout.once('data', resolve); lock.once('error', reject); });
  // A rejected flock exits before consuming this input. Node can report both
  // EPIPE from stdin and the explicit lock-conflict exit status (75).
  const blocked = await helper(root, { path: 'app.ts', content: 'x'.repeat(EDITOR_MAX_BYTES), expectedRevision: null });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'file_busy');
  assert.equal(fs.existsSync(path.join(root, 'app.ts')), false);
  process.kill(-lock.pid, 'SIGKILL');
  await new Promise((resolve) => lock.once('close', resolve));
  assert.deepEqual(fs.readdirSync(root), []);
});
