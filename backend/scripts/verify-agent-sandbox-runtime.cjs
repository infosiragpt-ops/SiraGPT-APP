'use strict';

// Stream this TARGET checkout's script into the old or new backend container.
// The expected catalog hash is an explicit CLI argument from TARGET, never
// inferred from the live backend's release or its runtime-verification module.
const path = require('node:path');
const CATALOG_MARKER = 'SIRA_RELEASE_CATALOG ';

class ReleaseVerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ReleaseVerificationError(code); };
const count = (value, max = 512) => Number.isInteger(value) && value >= 0 && value <= max;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function buildCatalogProbe(digest, catalogPath = '/opt/sira/capabilities.json') {
  if (!/^[0-9a-f]{64}$/.test(digest || '')) fail('invalid_expected_catalog');
  return `import hashlib, json, sys
try:
    with open(${JSON.stringify(catalogPath)}, 'rb') as handle:
        raw = handle.read(262145)
    if len(raw) > 262144 or hashlib.sha256(raw).hexdigest() != ${JSON.stringify(digest)}:
        raise ValueError('catalog mismatch')
    catalog = json.loads(raw)
    entries = catalog['python']
    proofs = sorted({entry['proof'] for entry in entries if 'proof' in entry})
    report = {'digest': hashlib.sha256(raw).hexdigest(), 'python': len(entries),
              'cli': len(catalog['cli']), 'node': len(catalog['node']), 'proofs': proofs,
              'libraries': sum('proof' in entry for entry in entries)}
    print(${JSON.stringify(CATALOG_MARKER)} + json.dumps(report, separators=(',', ':')))
except Exception:
    print('SIRA_RELEASE_CATALOG_FAILED')
    sys.exit(1)
`;
}

function checkedOutput(result, maxBytes, code) {
  if (result?.exitCode !== 0 || result?.timedOut || result?.aborted
    || typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > maxBytes) fail(code);
  return result.stdout.trim();
}

function parseCatalog(result, digest) {
  const output = checkedOutput(result, 8192, 'catalog_check_failed');
  if (!output.startsWith(CATALOG_MARKER)) fail('catalog_check_failed');
  let value;
  try { value = JSON.parse(output.slice(CATALOG_MARKER.length)); } catch { fail('catalog_check_failed'); }
  if (!value || value.digest !== digest || !count(value.python) || value.python < 1
    || !count(value.cli) || !count(value.node) || !count(value.libraries) || value.libraries < 1
    || value.libraries > value.python || !Array.isArray(value.proofs) || !value.proofs.length
    || value.proofs.length > value.libraries
    || value.proofs.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    || new Set(value.proofs).size !== value.proofs.length) fail('catalog_check_failed');
  return value;
}

function parseProofs(result, catalog) {
  const output = checkedOutput(result, 65536, 'functional_proof_failed');
  let value;
  try { value = JSON.parse(output); } catch { fail('functional_proof_failed'); }
  if (!value || value.ok !== true || value.complete === false || value.skipped || !count(value.checks, 100000) || value.checks < 1
    || value.libraries !== catalog.libraries || !Array.isArray(value.proofs)
    || value.proofs.length !== catalog.proofs.length) fail('functional_proof_failed');
  const ids = new Set();
  let checks = 0;
  for (const proof of value.proofs) {
    if (!proof || proof.ok !== true || proof.complete === false || proof.skipped || !catalog.proofs.includes(proof.id) || ids.has(proof.id)
      || !count(proof.checks, 100000) || proof.checks < 1
      || !Array.isArray(proof.artifacts) || !proof.artifacts.length
      || proof.artifacts.some((name) => typeof name !== 'string' || !name || name.length > 255)) fail('functional_proof_failed');
    ids.add(proof.id);
    checks += proof.checks;
  }
  if (checks !== value.checks) fail('functional_proof_failed');
  return { proofs: ids.size, checks };
}

const spssSource = [
  'import os, tempfile, pandas as pd, pyreadstat',
  'columns = [f"P{i:02d}" for i in range(1, 21)]',
  'frame = pd.DataFrame([[row * 100 + col for col in range(20)] for row in range(20)], columns=columns)',
  'with tempfile.NamedTemporaryFile(suffix=".sav", dir="/workspace", delete=False) as handle: path = handle.name',
  'try:',
  '    pyreadstat.write_sav(frame, path, column_labels={name: f"Pregunta {i}" for i, name in enumerate(columns, 1)})',
  '    restored, meta = pyreadstat.read_sav(path)',
  '    assert restored.shape == (20, 20)',
  '    assert restored.to_numpy().tolist() == frame.to_numpy().tolist()',
  '    assert sum(bool(label) for label in (meta.column_labels or [])) == 20',
  '    print("SPSS_RUNTIME_OK")',
  'finally:',
  '    os.unlink(path)',
].join('\n');

async function verifySandboxRelease(expectedDigest, { createSandbox } = {}) {
  const probe = buildCatalogProbe(expectedDigest); // validate before allocating
  let sandbox;
  try {
    const create = createSandbox || require(path.join(process.cwd(), 'src/services/doc-agent/sandbox')).createSandbox;
    sandbox = await create(); // no persistKey: probes never touch a user's files
    if (!['remote', 'docker'].includes(sandbox?.driver)) fail('sandbox_not_isolated');
    const catalog = parseCatalog(await sandbox.exec(`/usr/bin/python3 -I -s -c ${shellQuote(probe)}`, { timeoutMs: 10000 }), expectedDigest);
    // Hash agreement binds the image's own version/import checker and required
    // proof IDs to TARGET even when the calling backend is the previous release.
    const env = await sandbox.exec('SIRA_CAPABILITIES=/opt/sira/capabilities.json /usr/bin/python3 -E -s /opt/sira/verify_env.py', { timeoutMs: 60000 });
    if (checkedOutput(env, 8192, 'environment_check_failed')
      !== `SIRA_ENV_OK python=${catalog.python} cli=${catalog.cli} node=${catalog.node}`) fail('environment_check_failed');
    const spss = await sandbox.exec(`/usr/bin/python3 -I -s -c ${shellQuote(spssSource)}`, { timeoutMs: 30000 });
    if (checkedOutput(spss, 1024, 'spss_check_failed') !== 'SPSS_RUNTIME_OK') fail('spss_check_failed');
    const result = await sandbox.exec('/usr/bin/python3 -E -s /opt/sira/smoke_precision.py /workspace/tmp/release-proof --catalog /opt/sira/capabilities.json', { timeoutMs: 180000 });
    const verified = parseProofs(result, catalog);
    return { ok: true, driver: sandbox.driver, catalog: expectedDigest,
      python: catalog.python, libraries: catalog.libraries, ...verified };
  } catch (error) {
    if (error instanceof ReleaseVerificationError) throw error;
    fail('sandbox_transport_failed');
  } finally {
    try { await sandbox?.destroy(); } catch { fail('sandbox_cleanup_failed'); }
  }
}

async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 1) fail('expected_catalog_argument_required');
    const result = await verifySandboxRelease(args[0]);
    process.stdout.write(`SIRA_SANDBOX_RELEASE_OK ${JSON.stringify(result)}\n`);
  } catch (error) {
    // Never replay raw process output, endpoint, keys or session details.
    const code = error instanceof ReleaseVerificationError ? error.code : 'verification_failed';
    process.stderr.write(`SIRA_SANDBOX_RELEASE_FAILED ${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module || module.id === '[stdin]') main();
module.exports = { verifySandboxRelease, buildCatalogProbe, parseCatalog, parseProofs, CATALOG_MARKER };
