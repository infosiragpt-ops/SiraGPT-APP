"use strict";

// Real wheels, real pip resolver and real filesystem activation. The package
// index is private to this test and serves only synthetic, dependency-free code.
// No PyPI downloads, user documents or production credentials are involved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const pip = require('../src/services/doc-agent/sandbox-pip');

let fixtureRoot, server, indexUrl;
const ALLOW = ['sira-fixture-alpha', 'sira-fixture-beta', 'sira-fixture-gamma', 'sira-fixture-delta', 'sira-fixture-shared'];
const wheelSource = `
import base64, csv, hashlib, io, json, os, sys, zipfile
root = sys.argv[1]
for name, version, dependencies in [
    ('sira_fixture_shared', '1.0', []),
    ('sira_fixture_shared', '2.0', []),
    ('sira_fixture_alpha', '1.0', ['sira-fixture-shared==1.0']),
    ('sira_fixture_beta', '1.0', ['sira-fixture-shared==1.0']),
    ('sira_fixture_gamma', '1.0', ['sira-fixture-shared==2.0']),
    ('sira_fixture_delta', '1.0', []),
]:
    info = name + '-' + version + '.dist-info'
    source = 'VERSION = ' + repr(version) + '\\n'
    if dependencies:
        source += 'from sira_fixture_shared import VERSION as SHARED_VERSION\\n'
    entries = {
        name + '/__init__.py': source,
        info + '/WHEEL': 'Wheel-Version: 1.0\\nGenerator: sira-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
        info + '/METADATA': 'Metadata-Version: 2.1\\nName: ' + name.replace('_', '-') + '\\nVersion: ' + version + '\\n' + ''.join('Requires-Dist: ' + dep + '\\n' for dep in dependencies),
    }
    output = io.StringIO()
    writer = csv.writer(output, lineterminator='\\n')
    for filename, text in entries.items():
        content = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode().rstrip('=')
        writer.writerow([filename, 'sha256=' + digest, len(content)])
    writer.writerow([info + '/RECORD', '', ''])
    entries[info + '/RECORD'] = output.getvalue()
    filename = name + '-' + version + '-py3-none-any.whl'
    with zipfile.ZipFile(os.path.join(root, filename), 'w') as archive:
        for entry, text in entries.items():
            archive.writestr(entry, text)
`;

before(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-real-wheels-'));
  execFileSync('python3', ['-I', '-s', '-c', wheelSource, fixtureRoot]);
  // --report is required in the production runner too; fail rather than
  // silently substituting a fake installer on an unsupported test machine.
  const version = execFileSync('python3', ['-m', 'pip', '--version'], { encoding: 'utf8' });
  assert.ok(Number(version.match(/^pip (\d+)/)?.[1]) >= 23, `Use Python with pip >=23: ${version}`);
  const files = fs.readdirSync(fixtureRoot);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/simple/')) {
      const name = url.pathname.split('/')[2].replace(/-/g, '_');
      const matches = files.filter((file) => file.startsWith(name + '-'));
      res.writeHead(matches.length ? 200 : 404, { 'Content-Type': 'text/html' });
      res.end(matches.map((file) => `<a href="/wheels/${file}">${file}</a>`).join('\n'));
    } else if (url.pathname.startsWith('/wheels/') && files.includes(url.pathname.slice(8))) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(fs.readFileSync(path.join(fixtureRoot, url.pathname.slice(8))));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  indexUrl = `http://127.0.0.1:${server.address().port}/simple/`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function install(root, requirements, options = {}) {
  return pip.runSandboxInstall({ kind: 'local', root, requirements, allowJson: JSON.stringify(ALLOW),
    indexUrl, timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024, ...options });
}
function inspect(root, modules) {
  return JSON.parse(execFileSync('python3', ['-c',
    `import importlib, json; print(json.dumps({name: importlib.import_module(name).VERSION for name in ${JSON.stringify(modules)}}))`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, PYTHONUSERBASE: path.join(root, '.sira-packages'), PYTHONDONTWRITEBYTECODE: '1' },
  }));
}
function digest(root) {
  return execFileSync('python3', ['-I', '-s', '-c', `
import hashlib, os, sys
h = hashlib.sha256()
for directory, dirs, files in os.walk(sys.argv[1]):
    dirs.sort()
    for file in sorted(files):
        p = os.path.join(directory, file)
        h.update(os.path.relpath(p, sys.argv[1]).encode())
        h.update(open(p, 'rb').read())
print(h.hexdigest())
`, path.join(root, '.sira-packages')], { encoding: 'utf8' }).trim();
}
function noStaging(root) {
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.staging-')), []);
}

test('real pip installs accumulate, preserve versions and survive a fresh Python process', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  const first = await install(root, ['sira-fixture-alpha']);
  assert.equal(first.code, 'ok', JSON.stringify(first));
  const second = await install(root, ['sira-fixture-beta']);
  assert.equal(second.code, 'ok', JSON.stringify(second));
  assert.deepEqual(inspect(root, ['sira_fixture_alpha', 'sira_fixture_beta', 'sira_fixture_shared']), {
    sira_fixture_alpha: '1.0', sira_fixture_beta: '1.0', sira_fixture_shared: '1.0',
  });
  const check = execFileSync('python3', ['-m', 'pip', 'check'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, PYTHONUSERBASE: path.join(root, '.sira-packages') } });
  assert.match(check, /No broken requirements found/);
  noStaging(root);
});

test('an incompatible second wheel and an explicit version change preserve the original bytes', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  assert.equal((await install(root, ['sira-fixture-alpha'])).code, 'ok');
  const before = digest(root);
  for (const specs of [['sira-fixture-gamma'], ['sira-fixture-shared==2.0']]) {
    const result = await install(root, specs);
    assert.equal(result.code, 'conflict', JSON.stringify(result));
    assert.equal(digest(root), before);
  }
  assert.equal(inspect(root, ['sira_fixture_alpha']).sira_fixture_alpha, '1.0');
  noStaging(root);
});

test('a commit failure preserves the active tree and reports failure honestly', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  assert.equal((await install(root, ['sira-fixture-alpha'])).code, 'ok');
  const before = digest(root);
  const result = await install(root, ['sira-fixture-beta'], {
    runCommand: (cmd, args, opts) => args.join(' ').includes('renameat2')
      ? Promise.resolve({ exitCode: 1, stdout: JSON.stringify({ code: 'commit_failed', committed: false }), stderr: 'simulated filesystem refusal' })
      : pip.runCommandOnce(cmd, args, opts),
  });
  assert.equal(result.code, 'commit_failed', JSON.stringify(result));
  assert.equal(digest(root), before);
  noStaging(root);
});

test('overlapping installs cannot silently overwrite an intervening generation', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  assert.equal((await install(root, ['sira-fixture-alpha'])).code, 'ok');
  let entered = 0, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  function commands() {
    let first = true;
    return async (cmd, args, opts) => {
      const result = await pip.runCommandOnce(cmd, args, opts);
      if (first) {
        first = false;
        if (++entered === 2) release();
        await barrier;
      }
      return result;
    };
  }
  const results = await Promise.all([
    install(root, ['sira-fixture-beta'], { runCommand: commands() }),
    install(root, ['sira-fixture-delta'], { runCommand: commands() }),
  ]);
  assert.deepEqual(results.map((result) => result.code).sort(), ['environment_changed', 'ok']);
  assert.equal(inspect(root, ['sira_fixture_alpha']).sira_fixture_alpha, '1.0');
  // A fresh request can safely apply the missing addition without losing the winner.
  const retry = results[0].ok ? 'sira-fixture-delta' : 'sira-fixture-beta';
  assert.equal((await install(root, [retry])).code, 'ok');
  assert.equal(Object.keys(inspect(root, ['sira_fixture_alpha', 'sira_fixture_beta', 'sira_fixture_delta'])).length, 3);
  noStaging(root);
});

test('cancellation after download and before activation leaves the original environment', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  assert.equal((await install(root, ['sira-fixture-alpha'])).code, 'ok');
  const before = digest(root);
  const abort = new AbortController();
  const result = await install(root, ['sira-fixture-beta'], {
    signal: abort.signal,
    spawnImpl: (cmd, args, opts) => {
      const child = require('node:child_process').spawn(cmd, args, opts);
      // The consumer closes only after the candidate archive has been extracted.
      if (opts.stdio?.[0] === 'pipe') child.prependOnceListener('close', () => abort.abort());
      return child;
    },
  });
  assert.equal(result.code, 'aborted', JSON.stringify(result));
  assert.equal(digest(root), before);
  noStaging(root);
});


test('a lost commit response is recovered from the actual activated generation', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  const result = await install(root, ['sira-fixture-alpha'], {
    runCommand: async (cmd, args, opts) => {
      const actual = await pip.runCommandOnce(cmd, args, opts);
      return args.join(' ').includes('renameat2')
        ? { exitCode: 124, timedOut: true, stdout: '', stderr: '' }
        : actual;
    },
  });
  assert.equal(result.code, 'ok', JSON.stringify(result));
  assert.equal(inspect(root, ['sira_fixture_alpha']).sira_fixture_alpha, '1.0');
  noStaging(root);
});

test('missing activation confirmation is reported as unknown instead of claiming rollback', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  let lost = false;
  const result = await install(root, ['sira-fixture-alpha'], {
    runCommand: async (cmd, args, opts) => {
      if (args.join(' ').includes('renameat2')) lost = true;
      if (lost) return { exitCode: 124, timedOut: true, stdout: '', stderr: '' };
      return pip.runCommandOnce(cmd, args, opts);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'commit_unknown');
  assert.ok(fs.readdirSync(root).some((name) => name.includes('.staging-')), 'unconfirmed candidate is retained for inspection');
});

test('inventory reads metadata without running workspace startup hooks', { timeout: 60_000 }, async (t) => {
  const root = workspace(t);
  assert.equal((await install(root, ['sira-fixture-alpha'])).code, 'ok');
  const target = path.join(root, '.sira-packages');
  const site = execFileSync('python3', ['-I', '-s', '-c',
    'import site, sys; site.USER_BASE, site.USER_SITE = sys.argv[1], None; print(site.getusersitepackages())', target], { encoding: 'utf8' }).trim();
  const marker = path.join(root, 'startup-hook-ran');
  fs.writeFileSync(path.join(site, 'hostile.pth'), `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text('ran')\n`);
  const raw = execFileSync('python3', ['-I', '-s', '-c', pip.buildEnvironmentSnapshotScript(), target], { encoding: 'utf8' });
  const inventory = pip.parseEnvironmentSnapshot(raw);
  assert.ok(inventory.installed.some((item) => item.name === 'sira-fixture-alpha'));
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(site, 'sira_fixture_alpha-1.0.dist-info', 'METADATA'), 'Metadata-Version: 2.1\nName: invalid;name\nVersion: 1\n');
  const before = digest(root);
  const result = await install(root, ['sira-fixture-beta']);
  assert.equal(result.code, 'environment_invalid');
  assert.equal(digest(root), before);
  assert.equal(fs.existsSync(marker), false);
  noStaging(root);
});
