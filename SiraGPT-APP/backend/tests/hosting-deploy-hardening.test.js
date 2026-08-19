'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const sshExec = require('../src/services/hosting/ssh-exec');
const ftp = require('../src/services/hosting/ftp-transport');
const deploy = require('../src/services/hosting/deploy.service');

const tick = () => new Promise((r) => setImmediate(r));

// ── ssh-exec: cancel signal + timeout must tear down the remote command ──
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.signalled = []; this.closed = false; }
  signal(s) { this.signalled.push(s); }
  close() { this.closed = true; }
}
function makeClientClass(store) {
  return class FakeConn extends EventEmitter {
    constructor() { super(); store.conn = this; this.ended = false; this.destroyed = false; this._stream = new FakeStream(); }
    connect() { setImmediate(() => this.emit('ready')); }
    exec(cmd, cb) { this._cmd = cmd; setImmediate(() => cb(null, this._stream)); }
    end() { this.ended = true; }
    destroy() { this.destroyed = true; }
  };
}

test('ssh-exec: success resolves {code}, ends but does NOT hard-destroy or signal', async () => {
  const store = {};
  const p = sshExec.exec({ host: 'h', __deps: { ssh2: { Client: makeClientClass(store) } } }, 'echo hi', { timeoutMs: 5000 });
  await tick(); await tick(); // ready → exec → cb → listeners attached
  store.conn._stream.emit('close', 0);
  assert.deepEqual(await p, { code: 0 });
  assert.equal(store.conn.ended, true);
  assert.equal(store.conn.destroyed, false, 'no hard destroy on the success path');
  assert.deepEqual(store.conn._stream.signalled, [], 'no KILL on success');
});

test('ssh-exec: aborting the signal cancels and tears down (KILL + close + destroy)', async () => {
  const store = {};
  const ac = new AbortController();
  const p = sshExec.exec({ host: 'h', __deps: { ssh2: { Client: makeClientClass(store) } } }, 'sleep 999', { timeoutMs: 5000, signal: ac.signal });
  await tick(); await tick();
  ac.abort();
  await assert.rejects(p, /cancel/i);
  assert.deepEqual(store.conn._stream.signalled, ['KILL'], 'remote process signalled');
  assert.equal(store.conn._stream.closed, true);
  assert.equal(store.conn.ended, true);
  assert.equal(store.conn.destroyed, true, 'hard destroy on the abandon path');
});

test('ssh-exec: timeout rejects and tears down', async () => {
  const store = {};
  const p = sshExec.exec({ host: 'h', __deps: { ssh2: { Client: makeClientClass(store) } } }, 'sleep 999', { timeoutMs: 20 });
  await assert.rejects(p, /timed out/i);
  assert.equal(store.conn.ended, true);
  assert.equal(store.conn.destroyed, true);
});

test('ssh-exec: a pre-aborted signal rejects immediately without connecting', async () => {
  const store = {};
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    sshExec.exec({ host: 'h', __deps: { ssh2: { Client: makeClientClass(store) } } }, 'x', { signal: ac.signal }),
    /cancel/i,
  );
});

// ── ftp: plaintext connection must be flagged (warn, not block) ──
class FakeFtp { async access() {} async ensureDir() {} async clearWorkingDir() {} async uploadFromDir() {} close() {} }

test('ftp uploadDir warns on plaintext FTP but not on FTPS', async () => {
  const logs = [];
  await ftp.uploadDir(
    { protocol: 'ftp', host: 'h', username: 'u', password: 'p', localDir: '.', remoteDir: '/x', onLog: (l) => logs.push(l) },
    { ftp: { Client: FakeFtp } },
  );
  assert.ok(logs.some((l) => /sin cifrar/i.test(l)), 'plaintext FTP emits an unencrypted warning');

  const logs2 = [];
  await ftp.uploadDir(
    { protocol: 'ftps', host: 'h', username: 'u', password: 'p', localDir: '.', remoteDir: '/x', onLog: (l) => logs2.push(l) },
    { ftp: { Client: FakeFtp } },
  );
  assert.ok(!logs2.some((l) => /sin cifrar/i.test(l)), 'FTPS does not warn');
});

// ── deploy.service: secret redaction + global concurrency cap ──
test('deploy.redactSecrets masks secret values (≥6 chars), leaves the rest intact', () => {
  assert.equal(deploy.redactSecrets('TOKEN=supersecret123 ok', ['supersecret123']), 'TOKEN=*** ok');
  assert.equal(deploy.redactSecrets('a=SEKRET6 b=SEKRET6', ['SEKRET6']), 'a=*** b=***');
  assert.equal(deploy.redactSecrets('nothing to hide', ['supersecret123']), 'nothing to hide');
  assert.equal(deploy.redactSecrets('x', []), 'x');
  assert.equal(deploy.redactSecrets('x', null), 'x');
});

test('deploy.start throws 429 deploy_busy at the global concurrency cap', () => {
  deploy._jobs.clear();
  for (let i = 0; i < 3; i++) deploy._jobs.set(`busy${i}`, { id: `busy${i}`, status: 'building' });
  assert.throws(
    () => deploy.start('newdep', { localPath: '/tmp/none', target: { host: '1.2.3.4', protocol: 'sftp' }, config: {} }),
    (e) => e.status === 429 && e.code === 'deploy_busy',
  );
  // Terminal jobs don't count toward the cap → a slot frees up.
  deploy._jobs.set('busy0', { id: 'busy0', status: 'success' });
  assert.equal([...deploy._jobs.values()].filter((j) => ['queued', 'building', 'uploading'].includes(j.status)).length, 2);
  deploy._jobs.clear();
});
