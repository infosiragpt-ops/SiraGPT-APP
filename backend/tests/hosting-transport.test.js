'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeRemoteDir } = require('../src/services/hosting/remote-path');
const sftp = require('../src/services/hosting/sftp-transport');
const ftp = require('../src/services/hosting/ftp-transport');

test('normalizeRemoteDir cleans + rejects bad paths', () => {
  assert.equal(normalizeRemoteDir('/public_html/'), '/public_html');
  assert.equal(normalizeRemoteDir('/a//b///c'), '/a/b/c');
  assert.throws(() => normalizeRemoteDir(''), /required/i);
  assert.throws(() => normalizeRemoteDir('/a/../b'), /\.\./);
});

test('sftp uploadDir runs connect→mkdir→uploadDir→end (no clean)', async () => {
  const calls = [];
  class FakeClient {
    async connect() { calls.push('connect'); }
    async rmdir() { calls.push('rmdir'); }
    async mkdir(p, r) { calls.push(`mkdir:${p}:${r}`); }
    async uploadDir(l, r) { calls.push(`uploadDir:${r}`); }
    async end() { calls.push('end'); }
  }
  const res = await sftp.uploadDir(
    { host: 'h', port: 22, username: 'u', password: 'p', localDir: '.', remoteDir: '/public_html', cleanSlate: false },
    { Client: FakeClient },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['connect', 'mkdir:/public_html:true', 'uploadDir:/public_html', 'end']);
});

test('sftp uploadDir cleans first when cleanSlate', async () => {
  const calls = [];
  class FakeClient {
    async connect() {}
    async rmdir(p, r) { calls.push(`rmdir:${p}:${r}`); }
    async mkdir() { calls.push('mkdir'); }
    async uploadDir() { calls.push('uploadDir'); }
    async end() {}
  }
  await sftp.uploadDir(
    { host: 'h', username: 'u', password: 'p', localDir: '.', remoteDir: '/x', cleanSlate: true },
    { Client: FakeClient },
  );
  assert.equal(calls[0], 'rmdir:/x:true');
  assert.ok(calls.includes('uploadDir'));
});

test('sftp uploadDir passes a filter when exclude is set', async () => {
  let filterFn = null
  class FakeClient {
    async connect() {}
    async mkdir() {}
    async uploadDir(l, r, opts) {
      filterFn = opts && opts.filter
    }
    async end() {}
  }
  await sftp.uploadDir(
    { host: 'h', username: 'u', password: 'p', localDir: '/repo', remoteDir: '/app', exclude: ['node_modules', '.git'] },
    { Client: FakeClient },
  )
  assert.equal(typeof filterFn, 'function')
  // excluded paths are filtered out, normal ones kept
  const path = require('path')
  assert.equal(filterFn(path.join('/repo', 'node_modules', 'x')), false)
  assert.equal(filterFn(path.join('/repo', 'src', 'main.tsx')), true)
})

test('ftp uploadDir runs access→ensureDir→uploadFromDir→close', async () => {
  const calls = [];
  class FakeFtp {
    constructor() {}
    async access() { calls.push('access'); }
    async ensureDir(p) { calls.push(`ensureDir:${p}`); }
    async clearWorkingDir() { calls.push('clear'); }
    async uploadFromDir(l, r) { calls.push(`upload:${r}`); }
    close() { calls.push('close'); }
  }
  const res = await ftp.uploadDir(
    { protocol: 'ftp', host: 'h', port: 21, username: 'u', password: 'p', localDir: '.', remoteDir: '/public_html', cleanSlate: false },
    { ftp: { Client: FakeFtp } },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['access', 'ensureDir:/public_html', 'upload:/public_html', 'close']);
});
