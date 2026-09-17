'use strict';
// Approved recovery only: remove our new daemon.json after hash/absence proof.
// Never sends signals, changes a runtime, or removes the installed package.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { assertProductionUnchanged } = require('./install-runtime-config.cjs');
const { rollbackOperations: ops } = require('./install-runtime-apply.cjs');

function validateRecoveryEvidence(evidence) {
  if (evidence?.configuration?.originalHash !== 'absent' || !/^[a-f0-9]{64}$/.test(evidence?.configuration?.candidateHash || '') ||
    evidence?.configurationWrite?.configurationHash !== evidence.configuration.candidateHash ||
    !/^\/etc\/docker\/\.siragpt-runtime-[a-f0-9]{24}\.backup$/.test(evidence?.configurationWrite?.backup || '') ||
    evidence.configurationWrite.backupSha256 !== crypto.createHash('sha256').update('absent\n').digest('hex')) throw Error('invalid_recovery_evidence');
}

function main() {
  const evidencePath = process.argv[3];
  if (process.argv[2] !== '--restore-absent' || !/^\/private\/tmp\/siragpt-runtime-evidence\.[A-Za-z0-9]+\/evidence\.json$/.test(evidencePath || '')) {
    throw Error('explicit_mode_private_evidence_required');
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  validateRecoveryEvidence(evidence);
  const current = ops.snapshot();
  assertProductionUnchanged(evidence.before, current);
  if (Object.hasOwn(current.runtimes, 'runsc') || current.defaultRuntime !== 'runc') throw Error('runtime_state_changed_no_recovery');
  const bytes = current.config === null ? null : Buffer.from(current.config, 'base64');
  if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== evidence.configuration.candidateHash) throw Error('configuration_changed_no_recovery');
  const backupName = evidence.configurationWrite.backup.slice('/etc/docker/'.length);
  const response = ops.helper(`const fs=require('node:fs'),crypto=require('node:crypto');
    const readIdentity=${ops.readIdentity};const readConfiguration=${ops.readConfiguration};
    const expected=${JSON.stringify(current.daemon)},actual=readIdentity();
    if(actual.pid!==expected.pid||actual.startTicks!==expected.startTicks)throw Error('daemon_changed_before_recovery');
    if(fs.existsSync('/host-local-bin/.siragpt-gvisor-install-lock'))throw Error('installer_lock_exists');
    const backup='/host-docker/'+${JSON.stringify(backupName)};const stat=fs.lstatSync(backup);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||stat.gid!==0||(stat.mode&0o777)!==0o400||stat.size!==7)throw Error('backup_metadata_changed');
    const marker=fs.readFileSync(backup);if(!marker.equals(Buffer.from('absent\\n'))||crypto.createHash('sha256').update(marker).digest('hex')!==${JSON.stringify(evidence.configurationWrite.backupSha256)})throw Error('backup_changed');
    const current=readConfiguration().bytes;
    if(current===null||crypto.createHash('sha256').update(current).digest('hex')!==${JSON.stringify(evidence.configuration.candidateHash)})throw Error('candidate_changed');
    fs.unlinkSync('/host-docker/daemon.json');
    const fd=fs.openSync('/host-docker','r');fs.fsyncSync(fd);fs.closeSync(fd);
    if(fs.existsSync('/host-docker/daemon.json'))throw Error('configuration_still_present');
    console.log(JSON.stringify({restored:'absent',backupRetained:true,packageRetained:true}));`,
  [...ops.IDENTITY_MOUNTS, ...ops.bind('/etc/docker', '/host-docker', true), ...ops.bind('/usr/local/bin', '/host-local-bin')]);
  const final = ops.snapshot();
  assertProductionUnchanged(evidence.before, final);
  if (final.config !== null || Object.hasOwn(final.runtimes, 'runsc') || final.defaultRuntime !== 'runc') throw Error('final_recovery_state_invalid');
  evidence.recovery = { ...JSON.parse(response), completedAt: new Date().toISOString(), productionContinuityPassed: true,
    final: { ...final, config: undefined, runtimes: Object.keys(final.runtimes) } };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ recovered: true, configuration: 'absent', productionContainersUnchanged: final.containers.length,
    defaultRuntime: final.defaultRuntime, backupRetained: true, packageRetained: true, evidencePath }));
}
module.exports = { validateRecoveryEvidence };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ recovered: false, code: error.safeDiagnostic || error.code || error.message }));
    process.exitCode = 1;
  }
}
