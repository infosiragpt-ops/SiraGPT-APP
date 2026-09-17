'use strict';
// Explicit CAS recovery for the host adapter only. Retains backup and package.
const fs = require('node:fs');
const crypto = require('node:crypto');
const guards = require('./install-runtime-config.cjs');
const host = require('./install-runtime-host.cjs');
const { validateRecoveryEvidence } = require('./install-runtime-rollback.cjs');
function validateHostRecovery(evidence) {
  validateRecoveryEvidence(evidence);
  const expected = guards.planConfiguration(null).candidateHash;
  if (evidence.mode !== '--apply' || evidence.configuration.candidateHash !== expected ||
    !Number.isSafeInteger(evidence.configurationWrite.dev) || !Number.isSafeInteger(evidence.configurationWrite.ino) ||
    evidence.configurationWrite.ino <= 0 ||
    (evidence.configurationWrite.pending !== undefined &&
      evidence.configurationWrite.pending !== evidence.configurationWrite.backup.replace(/\.backup$/, '.candidate'))) throw Error('invalid_host_recovery_evidence');
}
async function main() {
  const filename = process.argv[3];
  if (process.argv[2] !== '--restore-absent' || process.argv.length !== 4 ||
      !/^\/tmp\/siragpt-runtime-host-evidence\.[A-Za-z0-9]+\/evidence\.json$/.test(filename || '')) throw Error('explicit_host_evidence_required');
  host.assertHost('--apply');
  host.assertTrustedMetadata(fs.lstatSync(require('node:path').dirname(filename)), true, 0o700);
  const evidence = JSON.parse(host.trustedFile(filename, 4 * 1024 * 1024, 0o600).bytes.toString('utf8'));
  validateHostRecovery(evidence);
  const nonce = crypto.randomBytes(12).toString('hex');
  const locks = host.acquireLocks(nonce);
  try {
    const current = host.snapshot(evidence.configurationWrite); host.assertContinuity(evidence.before, current);
    if (current.defaultRuntime !== 'runc' || (Object.hasOwn(current.runtimes, 'runsc') && current.runtimes.runsc !== guards.RUNTIME_PATH) ||
        current.containers.some(c => c.runtime === 'runsc' && c.status === 'running')) throw Error('active_runtime_prevents_recovery');
    const backup = host.trustedFile(evidence.configurationWrite.backup, 7, 0o400);
    if (!backup.bytes.equals(Buffer.from('absent\n')) || host.hash(backup.bytes) !== evidence.configurationWrite.backupSha256) throw Error('backup_changed');
    const config = host.configuration(evidence.configurationWrite);
    if (!config || config.dev !== evidence.configurationWrite.dev || config.ino !== evidence.configurationWrite.ino ||
        host.hash(config.bytes) !== evidence.configuration.candidateHash) throw Error('configuration_identity_or_hash_changed');
    guards.assertDaemonIdentity(evidence.before.daemon, host.daemonIdentity());
    fs.unlinkSync(host.CONFIG); host.syncDirectory('/etc/docker');
    evidence.recovery = { configurationRestored: 'absent', backupRetained: true, packageRetained: true,
      pendingCandidateRetained: config.nlink === 2, reloadConfirmed: false };
    host.saveEvidence(filename, evidence);
    evidence.recovery.final = await host.reload(evidence.before, 'absent', false);
    evidence.recovery.reloadConfirmed = true;
    evidence.recovery.completedAt = new Date().toISOString();
    console.log(JSON.stringify({ recovered: true, configuration: 'absent', containersUnchanged: current.containers.length, evidencePath: filename }));
  } finally {
    host.releaseLocks(locks, nonce);
    host.saveEvidence(filename, evidence);
  }
}
module.exports = { validateHostRecovery };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ recovered: false, code: error.code || error.message })); process.exitCode = 1; });
