'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { throwIfAborted } = require('../../utils/abort-signals');

const MARKER = 'SIRA_RUNTIME_CONTRACT ';
const MAX_REPORT_BYTES = 2048;
const MAX_CATALOG_BYTES = 256 * 1024;
// Read the same immutable release asset used to compose the agent's prompt.
// A successful check is scoped to prepareSandbox, never cached across sessions.
const catalogBytes = fs.readFileSync(path.join(__dirname, 'sandbox-capabilities.json'));
const EXPECTED = Object.freeze({
  digest: createHash('sha256').update(catalogBytes).digest('hex'),
  packages: JSON.parse(catalogBytes).python.length,
});

class SandboxCapabilitiesError extends Error {
  constructor(reason, counts = {}) {
    super('El entorno de documentos no coincide con las capacidades de esta versión. Es necesario actualizar el sandbox antes de continuar.');
    this.name = 'SandboxCapabilitiesError';
    this.code = 'sandbox_capabilities_mismatch';
    this.reason = reason;
    this.retryable = false;
    // Numeric diagnostics only: never propagate process output, paths or env.
    this.checked = counts.checked || 0;
    this.missing = counts.missing || 0;
    this.mismatched = counts.mismatched || 0;
  }
}

function sandboxTransportError(error = {}) {
  const message = String(error.message || '');
  if (error.code === 'sandbox_at_capacity' || error.category === 'capacity' || /sandbox service 429.*at_capacity/i.test(message)) {
    return Object.assign(new Error('El entorno de documentos está ocupado; reintenta en un momento.'), {
      code: 'sandbox_at_capacity', category: 'capacity', retryable: true, status: 429,
    });
  }
  if (error.code === 'remote_sandbox_timeout' || /remote_sandbox_timeout/.test(message) || error.name === 'TimeoutError') {
    return Object.assign(new Error('El entorno de documentos tardó demasiado en responder; reintenta en un momento.'), {
      code: 'remote_sandbox_timeout', retryable: true,
    });
  }
  return Object.assign(new Error('No se pudo iniciar el entorno de documentos. Inténtalo de nuevo.'), {
    code: 'sandbox_unavailable', retryable: true,
  });
}

/**
 * This program runs INSIDE the sandbox. The fixed interpreter and isolated
 * mode exclude workspace executables, PYTHONPATH and user-site .pth files.
 * Version checks inspect base and persisted user-site metadata without adding
 * the latter to sys.path or importing it. This is not a check of module bytes.
 * The image build remains responsible for actual import/format smoke tests.
 */
function buildRuntimeProbe(expected = EXPECTED, catalogPath = '/opt/sira/capabilities.json') {
  if (!/^[a-f0-9]{64}$/.test(expected.digest) || !Number.isInteger(expected.packages)
    || expected.packages < 1 || expected.packages > 512) throw new Error('invalid runtime expectation');
  return `import hashlib, importlib.metadata, json, site, sys
EXPECTED = ${JSON.stringify(expected.digest)}
EXPECTED_COUNT = ${expected.packages}
CATALOG = ${JSON.stringify(catalogPath)}
report = {"protocol": 1, "ok": False, "digest": "", "checked": 0, "missing": 0, "mismatched": 0, "reason": "probe_unavailable"}

def check():
    try:
        with open(CATALOG, "rb") as handle:
            raw = handle.read(${MAX_CATALOG_BYTES + 1})
        if len(raw) > ${MAX_CATALOG_BYTES}:
            report["reason"] = "catalog_invalid"
            return
        report["digest"] = hashlib.sha256(raw).hexdigest()
        if report["digest"] != EXPECTED:
            report["reason"] = "catalog_mismatch"
            return
        catalog = json.loads(raw)
        entries = catalog.get("python")
        if not isinstance(entries, list) or len(entries) != EXPECTED_COUNT:
            report["reason"] = "catalog_invalid"
            return
        from packaging.requirements import Requirement
        from packaging.utils import canonicalize_name
        from packaging.version import InvalidVersion, Version
        # -I excludes the user site from imports, but the normal executor sees
        # the persisted PYTHONUSERBASE set by the driver. Read its metadata
        # directly; never use addsitedir (which would execute .pth files).
        overlays = {}
        for distribution in importlib.metadata.distributions(path=[site.getusersitepackages()]):
            name = distribution.metadata.get("Name")
            if name:
                overlays.setdefault(canonicalize_name(name), []).append(distribution.version)
        for entry in entries:
            requirement = Requirement(entry["pip"])
            if requirement.url or requirement.marker or not requirement.specifier:
                report["reason"] = "catalog_invalid"
                return
            report["checked"] += 1
            try:
                version = importlib.metadata.version(requirement.name)
            except importlib.metadata.PackageNotFoundError:
                report["missing"] += 1
                continue
            try:
                base_version = Version(version)
                mismatch = not requirement.specifier.contains(base_version)
                # The installer preserves base-image versions. Even another
                # in-range overlay can break the image's tested dependency set.
                mismatch = mismatch or any(
                    Version(overlay) != base_version
                    for overlay in overlays.get(canonicalize_name(requirement.name), [])
                )
            except (InvalidVersion, TypeError):
                mismatch = True
            if mismatch:
                report["mismatched"] += 1
        report["ok"] = not (report["missing"] or report["mismatched"])
        report["reason"] = "verified" if report["ok"] else "packages_mismatch"
    except (ValueError, KeyError, TypeError):
        report["reason"] = "catalog_invalid"
    except Exception:
        report["reason"] = "probe_unavailable"

check()
print(${JSON.stringify(MARKER)} + json.dumps(report, separators=(",", ":")))
sys.exit(0 if report["ok"] else 1)
`;
}

function parseRuntimeReport(result, expected = EXPECTED) {
  if (result?.timedOut) throw sandboxTransportError({ code: 'remote_sandbox_timeout' });
  if (result?.aborted) throw sandboxTransportError();
  const output = result?.stdout;
  if (Number.isInteger(result?.exitCode) && result.exitCode !== 0
    && (typeof output !== 'string' || !output.startsWith(MARKER))) {
    // A killed process or stopped container did not report an image mismatch.
    throw sandboxTransportError();
  }
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_REPORT_BYTES
    || !output.startsWith(MARKER)) throw new SandboxCapabilitiesError('report_invalid');
  let report;
  try { report = JSON.parse(output.slice(MARKER.length)); } catch (_) {
    throw new SandboxCapabilitiesError('report_invalid');
  }
  const reasons = ['verified', 'catalog_mismatch', 'catalog_invalid', 'packages_mismatch', 'probe_unavailable'];
  if (!report || report.protocol !== 1 || typeof report.ok !== 'boolean'
    || typeof report.digest !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(report.digest)
    || !reasons.includes(report.reason)
    || !['checked', 'missing', 'mismatched'].every((key) => Number.isInteger(report[key]) && report[key] >= 0 && report[key] <= expected.packages)
    || report.missing + report.mismatched > report.checked) throw new SandboxCapabilitiesError('report_invalid');
  if (!report.ok) throw new SandboxCapabilitiesError(report.reason, report);
  if (result.exitCode !== 0 || report.reason !== 'verified' || report.digest !== expected.digest
    || report.checked !== expected.packages || report.missing || report.mismatched) {
    throw new SandboxCapabilitiesError('report_invalid', report);
  }
  return { verified: true, digest: report.digest, checked: report.checked };
}

async function verifySandboxRuntime(sandbox, { signal } = {}) {
  throwIfAborted(signal);
  // Local development deliberately uses the host, not the published image.
  // Do not mistake that exception for an attestation of installed libraries.
  if (sandbox?.driver === 'local') return { verified: false, reason: 'local_driver' };
  if (!['docker', 'remote'].includes(sandbox?.driver)) throw new SandboxCapabilitiesError('driver_unknown');
  let result;
  try {
    result = await sandbox.exec(`/usr/bin/python3 -I -s - <<'SIRA_RUNTIME_PROBE'\n${buildRuntimeProbe()}SIRA_RUNTIME_PROBE`, { timeoutMs: 10_000, signal });
  } catch (error) {
    throwIfAborted(signal);
    // First remote exec may still be allocating capacity, not checking an
    // image. Keep those transport failures distinct from an incompatible image.
    throw sandboxTransportError(error);
  }
  throwIfAborted(signal);
  return parseRuntimeReport(result);
}

module.exports = { verifySandboxRuntime, SandboxCapabilitiesError, buildRuntimeProbe, parseRuntimeReport, EXPECTED, MARKER };
