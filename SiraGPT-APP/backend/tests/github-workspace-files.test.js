'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const wf = require('../src/services/github/workspace-files.service');

/** Make an isolated temp "clone root" with a few files. */
async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sira-wf-'));
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.writeFile(path.join(root, '.git', 'config'), 'secret');
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fsp.writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'noise');
  await fsp.writeFile(path.join(root, 'README.md'), '# hello\n');
  await fsp.writeFile(path.join(root, 'src', 'app.js'), 'console.log(1)\n');
  return root;
}

async function cleanup(root) {
  await fsp.rm(root, { recursive: true, force: true });
}

test('resolveInside rejects traversal, absolute and .git', async () => {
  const root = await makeRoot();
  try {
    assert.throws(() => wf.resolveInside(root, '../escape'), /escape|Invalid/i);
    assert.throws(() => wf.resolveInside(root, 'a/../../b'), /escape|Invalid/i);
    assert.throws(() => wf.resolveInside(root, path.resolve(root, 'x')), /Invalid|escape/i);
    assert.throws(() => wf.resolveInside(root, '.git/config'), /\.git/i);
    assert.throws(() => wf.resolveInside(root, '-rf'), /Invalid/i);
    // a normal nested path resolves fine
    const ok = wf.resolveInside(root, 'src/app.js');
    assert.ok(ok.startsWith(path.resolve(root)));
  } finally {
    await cleanup(root);
  }
});

test('listTree skips .git + node_modules and nests dirs', async () => {
  const root = await makeRoot();
  try {
    const { tree } = await wf.listTree(root);
    const names = tree.map((n) => n.name);
    assert.ok(!names.includes('.git'), '.git hidden');
    assert.ok(!names.includes('node_modules'), 'node_modules hidden');
    assert.ok(names.includes('README.md'));
    const srcNode = tree.find((n) => n.name === 'src');
    assert.equal(srcNode.type, 'dir');
    assert.equal(srcNode.children[0].name, 'app.js');
    assert.equal(srcNode.children[0].path, 'src/app.js');
  } finally {
    await cleanup(root);
  }
});

test('readFile returns text, flags binary + tooLarge', async () => {
  const root = await makeRoot();
  try {
    const f = await wf.readFile(root, 'README.md');
    assert.equal(f.content, '# hello\n');

    await fsp.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
    const b = await wf.readFile(root, 'bin.dat');
    assert.equal(b.binary, true);

    const big = await wf.readFile(root, 'README.md', { maxBytes: 1 });
    assert.equal(big.tooLarge, true);

    await assert.rejects(() => wf.readFile(root, 'nope.txt'), /not found/i);
  } finally {
    await cleanup(root);
  }
});

test('writeFile creates parent dirs + rejects oversize', async () => {
  const root = await makeRoot();
  try {
    const res = await wf.writeFile(root, 'deep/nested/file.txt', 'hi');
    assert.equal(res.path, 'deep/nested/file.txt');
    const back = await wf.readFile(root, 'deep/nested/file.txt');
    assert.equal(back.content, 'hi');
    await assert.rejects(() => wf.writeFile(root, 'big.txt', 'xxxx', { maxBytes: 2 }), /limit/i);
    await assert.rejects(() => wf.writeFile(root, '.git/hack', 'x'), /\.git/i);
  } finally {
    await cleanup(root);
  }
});

test('readAllText returns text files, skips binary/.git/node_modules', async () => {
  const root = await makeRoot()
  try {
    await fsp.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0]))
    const { files } = await wf.readAllText(root)
    const paths = files.map((f) => f.path).sort()
    assert.ok(paths.includes('README.md'))
    assert.ok(paths.includes('src/app.js'))
    assert.ok(!paths.some((p) => p.startsWith('.git')), 'no .git')
    assert.ok(!paths.some((p) => p.startsWith('node_modules')), 'no node_modules')
    assert.ok(!paths.includes('bin.dat'), 'binary skipped')
    const readme = files.find((f) => f.path === 'README.md')
    assert.equal(readme.content, '# hello\n')
  } finally {
    await cleanup(root)
  }
})

test('createFolder, rename and deleteEntry', async () => {
  const root = await makeRoot();
  try {
    const folder = await wf.createFolder(root, 'lib/utils');
    assert.equal(folder.type, 'dir');
    assert.ok(fs.existsSync(path.join(root, 'lib', 'utils')));

    const moved = await wf.rename(root, 'README.md', 'docs/README.md');
    assert.equal(moved.to, 'docs/README.md');
    assert.ok(fs.existsSync(path.join(root, 'docs', 'README.md')));
    assert.ok(!fs.existsSync(path.join(root, 'README.md')));

    await assert.rejects(() => wf.rename(root, 'docs/README.md', 'src/app.js'), /exists/i);

    const del = await wf.deleteEntry(root, 'src');
    assert.equal(del.deleted, true);
    assert.ok(!fs.existsSync(path.join(root, 'src')));

    await assert.rejects(() => wf.deleteEntry(root, ''), /root/i);
  } finally {
    await cleanup(root);
  }
});
