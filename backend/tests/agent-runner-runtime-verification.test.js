'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  verifySandboxRuntime, SandboxCapabilitiesError, buildRuntimeProbe,
  parseRuntimeReport, EXPECTED, MARKER,
} = require('../src/services/agent-runner/runtime-verification');

const success = (extra = {}) => ({ stdout: MARKER + JSON.stringify({
  protocol: 1, ok: true, digest: EXPECTED.digest, checked: EXPECTED.packages,
  missing: 0, mismatched: 0, reason: 'verified', ...extra,
}) + '\n', exitCode: 0 });
const pythonReady = spawnSync('python3', ['-I', '-s', '-c', 'import packaging']).status === 0;
const pythonOptions = { skip: !pythonReady && 'python3 with packaging required for real metadata probes' };

function expectFailure(reason) {
  return (error) => error instanceof SandboxCapabilitiesError
    && error.code === 'sandbox_capabilities_mismatch' && error.reason === reason;
}

function userSiteFixture(root) {
  const userbase = path.join(root, 'userbase');
  const env = { ...process.env, PYTHONUSERBASE: userbase };
  const child = spawnSync('python3', ['-I', '-s', '-c', 'import site; print(site.getusersitepackages())'], {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const directory = child.stdout.trim();
  assert.ok(directory.startsWith(userbase + path.sep));
  fs.mkdirSync(directory, { recursive: true });
  return { directory, env };
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-runtime-probe-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(site);
  function distribution(name, version, directory = site) {
    const info = path.join(directory, `${name.replaceAll('-', '_')}-${version}.dist-info`);
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
  }
  function catalog(requirements) {
    const raw = JSON.stringify({ version: 2, python: requirements.map((pip) => ({ pip })), cli: [], node: [] });
    const file = path.join(root, 'capabilities.json');
    fs.writeFileSync(file, raw);
    return { file, expected: { digest: createHash('sha256').update(raw).digest('hex'), packages: requirements.length, requirements } };
  }
  function probe(config, { paths = [site], env = process.env } = {}) {
    const code = `import sys\nsys.path[0:0] = ${JSON.stringify(paths)}\n${buildRuntimeProbe(config.expected, config.file)}`;
    const child = spawnSync('python3', ['-I', '-s', '-c', code], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined);
    return { stdout: child.stdout, stderr: child.stderr, exitCode: child.status };
  }
  try { return fn({ root, site, distribution, catalog, probe }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('remote and docker verify each sandbox, using isolated absolute Python and bounded timeout', async () => {
  const calls = [];
  for (const driver of ['remote', 'docker']) {
    const verified = await verifySandboxRuntime({ driver, exec: async (command, opts) => {
      calls.push(command);
      assert.match(command, /^\/usr\/bin\/python3 -I -s - <<'SIRA_RUNTIME_PROBE'/);
      assert.ok(opts.timeoutMs <= 10_000);
      return success();
    } });
    assert.deepEqual(verified, { verified: true, digest: EXPECTED.digest, checked: EXPECTED.packages, catalogMatches: true });
  }
  assert.equal(calls.length, 2, 'success is not globally cached for the next sandbox');
});

test('explicit local development is unverified and makes no image assumptions', async () => {
  const result = await verifySandboxRuntime({ driver: 'local', exec: () => assert.fail('must not probe host as image') });
  assert.deepEqual(result, { verified: false, reason: 'local_driver' });
  await assert.rejects(verifySandboxRuntime({}), expectFailure('driver_unknown'));
});

test('invalid, partial, timed out and contradictory reports cannot attest the runtime', () => {
  const cases = [
    { stdout: 'SIRA_ENV_OK python=99', exitCode: 0 },
    { stdout: MARKER + '{', exitCode: 0 },
    { ...success(), stdout: success().stdout.repeat(2) },
    { ...success(), stdout: MARKER + ' '.repeat(3000) },
    success({ checked: 0 }), success({ missing: 1 }),
    success({ ok: 'true' }), { ...success(), exitCode: 1 }, { ...success(), exitCode: null },
  ];
  for (const result of cases) assert.throws(() => parseRuntimeReport(result), expectFailure('report_invalid'));
  // A different image catalog is a NEWER image (more libraries), not a broken one:
  // compatible as long as every promised package checked out.
  assert.deepEqual(parseRuntimeReport(success({ digest: '0'.repeat(64) })), { verified: true, digest: '0'.repeat(64), checked: EXPECTED.packages, catalogMatches: false });
  assert.throws(() => parseRuntimeReport({ ...success(), timedOut: true }), (error) => error.code === 'remote_sandbox_timeout');
  assert.throws(() => parseRuntimeReport({ ...success(), aborted: true }), (error) => error.code === 'sandbox_unavailable');
});

test('process failures expose only a stable diagnostic and cancellation stays cancellation', async () => {
  const secretText = 'Bearer do-not-echo test-private-path';
  await assert.rejects(verifySandboxRuntime({ driver: 'docker', exec: async () => { throw new Error(secretText); } }), (error) => {
    assert.equal(error.code, 'sandbox_unavailable');
    assert.ok(!JSON.stringify(error).includes(secretText));
    assert.ok(!error.message.includes(secretText));
    return true;
  });
  const controller = new AbortController();
  const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(verifySandboxRuntime({ driver: 'remote', exec: async () => {
    controller.abort(abortError);
    return success();
  } }, { signal: controller.signal }), (error) => error === abortError);
});

test('real metadata accepts versions within bounds without importing the library', pythonOptions, () => withFixture(({ site, distribution, catalog, probe }) => {
  distribution('sira-fixture', '1.4.2');
  fs.writeFileSync(path.join(site, 'sira_fixture.py'), 'raise RuntimeError("library imports are forbidden in the metadata probe")\n');
  const config = catalog(['sira-fixture>=1.4,<2']);
  assert.deepEqual(parseRuntimeReport(probe(config), config.expected), { verified: true, digest: config.expected.digest, checked: 1, catalogMatches: true });
}));

test('real metadata counts missing and out-of-range distributions even when catalog hashes match', pythonOptions, () => withFixture(({ distribution, catalog, probe }) => {
  distribution('sira-fixture', '2.0');
  const config = catalog(['sira-fixture>=1,<2', 'sira-package-does-not-exist==1']);
  const result = probe(config);
  assert.equal(result.exitCode, 1);
  assert.throws(() => parseRuntimeReport(result, config.expected), (error) => {
    assert.ok(expectFailure('packages_mismatch')(error));
    assert.equal(error.checked, 2);
    assert.equal(error.missing, 1);
    assert.equal(error.mismatched, 1);
    return true;
  });
}));

test('a newer image that promises more is accepted; one missing a promised package is not', pythonOptions, () => withFixture(({ distribution, catalog, probe }) => {
  // During a deploy the new image goes live minutes before the new backend:
  // its catalog lists extra libraries, but everything THIS release promises
  // is installed in range, so document tasks keep working.
  distribution('sira-fixture', '1.0');
  distribution('sira-extra', '3.1');
  const config = catalog(['sira-fixture==1.0']);
  fs.writeFileSync(config.file, JSON.stringify({ python: [{ pip: 'sira-fixture==1.0' }, { pip: 'sira-extra>=3,<4' }] }));
  const accepted = parseRuntimeReport(probe(config), config.expected);
  assert.equal(accepted.verified, true);
  assert.equal(accepted.catalogMatches, false);
  // The promise is still enforced: a promised package absent from the image fails.
  const promise = catalog(['sira-fixture==1.0', 'sira-removed>=1']);
  fs.writeFileSync(promise.file, JSON.stringify({ python: [{ pip: 'sira-fixture==1.0' }] }));
  assert.throws(() => parseRuntimeReport(probe(promise), promise.expected), (error) => {
    assert.ok(expectFailure('packages_mismatch')(error));
    assert.equal(error.missing, 1);
    return true;
  });
  // A probe without the promised list is refused outright.
  assert.throws(() => buildRuntimeProbe({ digest: config.expected.digest, packages: 1 }), /invalid runtime expectation/);
}));

test('base metadata follows effective sys.path precedence without executing user-site .pth', pythonOptions, () => withFixture(({ root, site, distribution, catalog, probe }) => {
  distribution('sira-fixture', '1.5');
  const shadow = path.join(root, 'shadow');
  distribution('sira-fixture', '2.0', shadow);
  const config = catalog(['sira-fixture>=1,<2']);
  const userbase = path.join(root, 'userbase');
  const env = { ...process.env, PYTHONUSERBASE: userbase };
  const userSite = spawnSync('python3', ['-c', 'import site; print(site.getusersitepackages())'], { env, encoding: 'utf8' }).stdout.trim();
  assert.ok(userSite.startsWith(userbase));
  fs.mkdirSync(userSite, { recursive: true });
  const marker = path.join(root, 'user-code-executed');
  fs.writeFileSync(path.join(userSite, 'hostile.pth'), `import pathlib; pathlib.Path(${JSON.stringify(marker)}).touch()\n`);
  assert.equal(parseRuntimeReport(probe(config, { paths: [site, shadow], env }), config.expected).verified, true);
  assert.throws(() => parseRuntimeReport(probe(config, { paths: [shadow, site], env }), config.expected), expectFailure('packages_mismatch'));
  assert.equal(fs.existsSync(marker), false);
}));

test('persisted user-site cannot replace a catalog package, even with another version inside its range', pythonOptions, () => {
  for (const version of ['2.0', '1.6']) {
    withFixture(({ root, distribution, catalog, probe }) => {
      distribution('sira-fixture', '1.5');
      const { directory, env } = userSiteFixture(root);
      distribution('sira-fixture', version, directory);
      const config = catalog(['sira-fixture>=1,<2']);
      const result = probe(config, { env });
      assert.equal(result.exitCode, 1);
      assert.throws(() => parseRuntimeReport(result, config.expected), (error) => {
        assert.ok(expectFailure('packages_mismatch')(error));
        assert.equal(error.checked, 1);
        assert.equal(error.missing, 0);
        assert.equal(error.mismatched, 1);
        return true;
      });
    });
  }
});

test('identical normalized versions in user-site preserve the base contract', pythonOptions, () => withFixture(({ root, distribution, catalog, probe }) => {
  distribution('sira-fixture', '1.5');
  const { directory, env } = userSiteFixture(root);
  distribution('sira-fixture', '1.5.0', directory);
  const config = catalog(['sira-fixture>=1,<2']);
  assert.equal(parseRuntimeReport(probe(config, { env }), config.expected).verified, true);
}));

test('unrelated user-site libraries do not invalidate a catalog package', pythonOptions, () => withFixture(({ root, distribution, catalog, probe }) => {
  distribution('sira-fixture', '1.5');
  const { directory, env } = userSiteFixture(root);
  distribution('unrelated-library', '9.0', directory);
  const config = catalog(['sira-fixture==1.5']);
  assert.equal(parseRuntimeReport(probe(config, { env }), config.expected).verified, true);
}));

test('user-site names use canonical case, dash, underscore and dot matching', pythonOptions, () => withFixture(({ root, distribution, catalog, probe }) => {
  distribution('sira-fixture-name', '1.5');
  const { directory, env } = userSiteFixture(root);
  distribution('SiRa_Fixture.Name', '2.0', directory);
  const config = catalog(['sira-fixture-name==1.5']);
  assert.throws(() => parseRuntimeReport(probe(config, { env }), config.expected), expectFailure('packages_mismatch'));
}));

test('contradictory or invalid user-site metadata counts a catalog mismatch only once', pythonOptions, () => {
  for (const versions of [['1.5', '2.0', '3.0'], ['not-a-version']]) {
    withFixture(({ root, distribution, catalog, probe }) => {
      distribution('sira-fixture', '1.5');
      const { directory, env } = userSiteFixture(root);
      for (const version of versions) distribution('sira-fixture', version, directory);
      const config = catalog(['sira-fixture>=1,<2']);
      assert.throws(() => parseRuntimeReport(probe(config, { env }), config.expected), (error) => {
        assert.ok(expectFailure('packages_mismatch')(error));
        assert.equal(error.checked, 1);
        assert.equal(error.missing, 0);
        assert.equal(error.mismatched, 1);
        return true;
      });
    });
  }
});

test('user-site cannot satisfy a missing base-image package', pythonOptions, () => withFixture(({ root, distribution, catalog, probe }) => {
  const { directory, env } = userSiteFixture(root);
  distribution('sira-package-does-not-exist', '1.5', directory);
  const config = catalog(['sira-package-does-not-exist==1.5']);
  assert.throws(() => parseRuntimeReport(probe(config, { env }), config.expected), (error) => {
    assert.ok(expectFailure('packages_mismatch')(error));
    assert.equal(error.missing, 1);
    assert.equal(error.mismatched, 0);
    return true;
  });
}));

test('direct user-site inspection executes neither modules nor .pth code or path additions', pythonOptions, () => withFixture(({ root, distribution, catalog, probe }) => {
  distribution('sira-fixture', '1.5');
  const { directory, env } = userSiteFixture(root);
  distribution('sira-fixture', '1.5', directory);
  const injected = path.join(root, 'injected');
  distribution('sira-fixture', '2.0', injected);
  const marker = path.join(root, 'user-code-executed');
  const hostile = `import pathlib; pathlib.Path(${JSON.stringify(marker)}).touch(); raise RuntimeError("user code executed")\n`;
  fs.writeFileSync(path.join(directory, 'hostile.pth'), hostile + injected + '\n');
  for (const filename of ['packaging.py', 'sira_fixture.py', 'sitecustomize.py', 'usercustomize.py']) {
    fs.writeFileSync(path.join(directory, filename), hostile);
  }
  const config = catalog(['sira-fixture==1.5']);
  assert.equal(parseRuntimeReport(probe(config, { env }), config.expected).verified, true);
  assert.equal(fs.existsSync(marker), false);
}));


test('image verifier rejects an importable library with a version outside the catalog', pythonOptions, () => withFixture(({ root, site, distribution, catalog }) => {
  distribution('sira-fixture', '2.0');
  fs.writeFileSync(path.join(site, 'sira_fixture.py'), "VALUE = 'importable'\n");
  const config = catalog(['sira-fixture>=1,<2']);
  const value = JSON.parse(fs.readFileSync(config.file, 'utf8'));
  value.python[0].import = 'sira_fixture';
  fs.writeFileSync(config.file, JSON.stringify(value));
  const verifier = path.resolve(__dirname, '../../services/sandbox/runner/verify_env.py');
  const script = `import sys, runpy\nsys.path.insert(0, ${JSON.stringify(site)})\nrunpy.run_path(${JSON.stringify(verifier)}, run_name="__main__")`;
  const run = () => spawnSync('python3', ['-I', '-s', '-c', script], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, SIRA_CAPABILITIES: config.file },
  });
  const failed = run();
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /python version sira-fixture=2.0 outside/);
  assert.doesNotMatch(failed.stderr, /python import/);
  assert.doesNotMatch(failed.stdout, /SIRA_ENV_OK/);
  value.python[0].pip = 'sira-fixture>=2,<3';
  fs.writeFileSync(config.file, JSON.stringify(value));
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /SIRA_ENV_OK python=1 cli=0 node=0/);
}));


test('the complete real release catalog supports distribution extras and all requirement shapes', pythonOptions, () => withFixture(({ site, probe, root }) => {
  const catalogPath = path.resolve(__dirname, '../src/services/agent-runner/sandbox-capabilities.json');
  const raw = fs.readFileSync(catalogPath);
  const catalog = JSON.parse(raw);
  assert.ok(catalog.python.some((entry) => /\[.+\]/.test(entry.pip)), 'covers the actual fonttools[woff] requirement');
  const code = `import json, pathlib\nfrom packaging.requirements import Requirement\nentries = json.loads(pathlib.Path(${JSON.stringify(catalogPath)}).read_text())["python"]\nsite = pathlib.Path(${JSON.stringify(site)})\nfor entry in entries:\n    req = Requirement(entry["pip"])\n    candidates = [s.version for s in req.specifier if s.operator in ("==", ">=", "~=") and "*" not in s.version]\n    version = next((v for v in candidates if req.specifier.contains(v)), None)\n    assert version is not None, entry["pip"]\n    info = site / (req.name.replace("-", "_") + "-" + version + ".dist-info")\n    info.mkdir()\n    (info / "METADATA").write_text("Metadata-Version: 2.1\\nName: " + req.name + "\\nVersion: " + version + "\\n")\n`;
  const fixture = spawnSync('python3', ['-I', '-s', '-c', code], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  const copy = path.join(root, 'release-catalog.json');
  fs.writeFileSync(copy, raw);
  const expected = { digest: createHash('sha256').update(raw).digest('hex'), packages: catalog.python.length, requirements: catalog.python.map((entry) => entry.pip) };
  const result = parseRuntimeReport(probe({ file: copy, expected }), expected);
  assert.equal(result.checked, catalog.python.length);
  assert.equal(result.verified, true);
}));

test('version constraints accept explicit prereleases and retain stable lower bounds', pythonOptions, () => withFixture(({ distribution, catalog, probe }) => {
  distribution('sira-fixture', '2.0rc1');
  const release = catalog(['sira-fixture>=2,<3']);
  assert.throws(() => parseRuntimeReport(probe(release), release.expected), expectFailure('packages_mismatch'));
  const preview = catalog(['sira-fixture==2.0rc1']);
  assert.equal(parseRuntimeReport(probe(preview), preview.expected).verified, true);
}));


test('capacity and timeout while allocating the first remote session keep their transport classification', async () => {
  const { sandboxFailureReason } = require('../src/services/agent-runner');
  const cases = [
    [Object.assign(new Error('capacity detail not exposed'), { code: 'sandbox_at_capacity', category: 'capacity' }), 'sandbox_capacity'],
    [new Error('remote_sandbox_timeout'), 'sandbox_timeout'],
    [Object.assign(new Error('private transport detail'), { name: 'TimeoutError' }), 'sandbox_timeout'],
    [Object.assign(new Error('private service detail'), { status: 503 }), 'sandbox_unavailable'],
  ];
  for (const [source, classification] of cases) {
    await assert.rejects(verifySandboxRuntime({ driver: 'remote', exec: async () => { throw source; } }), (error) => {
      assert.equal(sandboxFailureReason(error), classification);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /private|not exposed/);
      return true;
    });
  }
});


test('a killed or unavailable exec process without a report is a transport failure', () => {
  for (const result of [
    { stdout: '', stderr: 'container is not running', exitCode: 1 },
    { stdout: '', stderr: 'Killed', exitCode: 137 },
  ]) {
    assert.throws(() => parseRuntimeReport(result), (error) => {
      assert.equal(error.code, 'sandbox_unavailable');
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /actualizar|container|Killed/);
      return true;
    });
  }
});

test('a chat whose installed packages shadow the image is repaired, not broken forever', async () => {
  const report = (extra) => ({ stdout: MARKER + JSON.stringify({
    protocol: 1, ok: false, digest: EXPECTED.digest, checked: EXPECTED.packages,
    missing: 0, mismatched: 2, overlay: 2, cliMissing: 0, reason: 'packages_mismatch', ...extra,
  }) + '\n', exitCode: 1 });
  const commands = [];
  let probes = 0;
  const sandbox = {
    driver: 'remote',
    exec: async (command) => {
      commands.push(command);
      if (command.startsWith('/usr/bin/python3 -I -s - <<')) {
        probes += 1;
        return probes === 1 ? report() : success();
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const verified = await verifySandboxRuntime(sandbox);
  assert.equal(verified.verified, true);
  assert.equal(verified.overlayReset, true);
  assert.deepEqual(commands.filter((c) => !c.startsWith('/usr/bin/python3')), ['command -p rm -rf -- /workspace/.sira-packages']);
  assert.equal(probes, 2);

  // A broken IMAGE (base versions wrong or a package missing) is never "repaired".
  for (const bad of [report({ overlay: 1 }), report({ missing: 1, mismatched: 1, overlay: 1 })]) {
    const cleaned = [];
    await assert.rejects(verifySandboxRuntime({
      driver: 'docker',
      exec: async (command) => { cleaned.push(command); return command.startsWith('/usr/bin/python3') ? bad : { exitCode: 0 }; },
    }), expectFailure('packages_mismatch'));
    assert.equal(cleaned.filter((c) => c.includes('rm -rf')).length, 0);
  }
});

test('promised command-line tools are checked again (cli_missing)', async () => {
  assert.ok(EXPECTED.cli.includes('soffice') && EXPECTED.cli.includes('ffmpeg'));
  const probe = buildRuntimeProbe();
  assert.match(probe, /CLI = json\.loads\(/);
  assert.match(probe, /shutil\.which\(name\) is None/);
  const missingTool = { stdout: MARKER + JSON.stringify({
    protocol: 1, ok: false, digest: EXPECTED.digest, checked: EXPECTED.packages,
    missing: 0, mismatched: 0, overlay: 0, cliMissing: 1, reason: 'cli_missing',
  }) + '\n', exitCode: 1 };
  assert.throws(() => parseRuntimeReport(missingTool), expectFailure('cli_missing'));
  assert.throws(() => buildRuntimeProbe({ ...EXPECTED, cli: ['soffice; rm -rf /'] }), /invalid runtime expectation/);
  // An impossible count is not trusted.
  const lying = { stdout: MARKER + JSON.stringify({
    protocol: 1, ok: true, digest: EXPECTED.digest, checked: EXPECTED.packages,
    missing: 0, mismatched: 0, overlay: 0, cliMissing: 999, reason: 'verified',
  }) + '\n', exitCode: 0 };
  assert.throws(() => parseRuntimeReport(lying), expectFailure('report_invalid'));
});
