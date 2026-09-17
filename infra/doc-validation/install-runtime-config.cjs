'use strict';

// Pure planner and verification guards. This module NEVER changes host files,
// signals processes, executes binaries, or contacts Docker.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const RELEASE = '20260817.0';
const ARCHIVE = `https://storage.googleapis.com/gvisor/releases/release/${RELEASE}/x86_64/gvisor.tar.bz2`;
const ARCHIVE_BYTES = 164966070;
const ARCHIVE_SHA512 = 'bd8271a7742f90e53373b2a8613f37f3ae2c765ff5e2e611a75a47167a323cab7519b149c50273307743491713525a14ad1b3e398651c93b16f3e248dfeff3dd';
const RUNTIME_PATH = `/usr/local/bin/siragpt-gvisor-${RELEASE}/runsc`;

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function requireValue(ok, code) { if (!ok) throw Error(code); }

function planConfiguration(originalBytes) {
  requireValue(originalBytes === null || Buffer.isBuffer(originalBytes), 'config_not_buffer');
  requireValue(originalBytes === null || originalBytes.length <= 1024 * 1024, 'config_too_large');
  const original = originalBytes === null ? {} : JSON.parse(originalBytes.toString('utf8'));
  requireValue(record(original), 'config_not_object');
  requireValue(!Object.hasOwn(original, 'runtimes') || record(original.runtimes), 'runtimes_not_object');
  const intended = { path: RUNTIME_PATH };
  if (Object.hasOwn(original.runtimes || {}, 'runsc')) {
    requireValue(isDeepStrictEqual(original.runtimes.runsc, intended), 'runsc_already_configured_differently');
    return { noop: true, originalHash: hash(originalBytes), candidateHash: hash(originalBytes), candidate: Buffer.from(originalBytes) };
  }
  const candidate = structuredClone(original);
  candidate.runtimes = { ...candidate.runtimes, runsc: intended };
  const withoutAddition = structuredClone(candidate);
  delete withoutAddition.runtimes.runsc;
  if (!Object.hasOwn(original, 'runtimes')) delete withoutAddition.runtimes;
  requireValue(isDeepStrictEqual(withoutAddition, original), 'unrelated_config_mutation');
  const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  return { noop: false, originalHash: originalBytes === null ? 'absent' : hash(originalBytes), candidateHash: hash(bytes), candidate: bytes };
}

function assertUnchangedConfiguration(currentBytes, expectedHash) {
  requireValue(expectedHash === 'absent' || /^[a-f0-9]{64}$/.test(expectedHash), 'invalid_expected_config_hash');
  requireValue(currentBytes === null || Buffer.isBuffer(currentBytes), 'config_not_buffer');
  const currentHash = currentBytes === null ? 'absent' : hash(currentBytes);
  requireValue(currentHash === expectedHash, 'configuration_changed_since_preflight');
}

function assertDaemonIdentity(expected, current) {
  for (const value of [expected, current]) {
    requireValue(record(value) && Number.isSafeInteger(value.pid) && value.pid > 1 && value.comm === 'dockerd' &&
      typeof value.startTicks === 'string' && /^[1-9][0-9]*$/.test(value.startTicks), 'invalid_daemon_identity');
  }
  requireValue(expected.pid === current.pid && expected.startTicks === current.startTicks, 'docker_process_changed');
}

function assertProductionUnchanged(before, after) {
  requireValue(record(before) && record(after) && typeof before.defaultRuntime === 'string' && before.defaultRuntime.length > 0 &&
    after.defaultRuntime === before.defaultRuntime, 'default_runtime_changed');
  requireValue(Array.isArray(before.containers) && before.containers.length > 0 && Array.isArray(after.containers), 'invalid_container_snapshots');
  for (const snapshot of [before.containers, after.containers]) {
    const identifiers = new Set();
    for (const item of snapshot) {
      requireValue(record(item) && typeof item.id === 'string' && /^[a-f0-9]{64}$/.test(item.id) &&
        typeof item.name === 'string' && item.name.length > 0 && Number.isSafeInteger(item.pid) && item.pid > 1 &&
        typeof item.startedAt === 'string' && Number.isFinite(Date.parse(item.startedAt)) && item.status === 'running', 'invalid_container_snapshot');
      requireValue(!identifiers.has(item.id), 'duplicate_container_snapshot');
      identifiers.add(item.id);
    }
  }
  const afterById = new Map(after.containers.map(item => [item.id, item]));
  for (const previous of before.containers) {
    const current = afterById.get(previous.id);
    requireValue(current && current.name === previous.name && current.pid === previous.pid && current.startedAt === previous.startedAt,
      'existing_container_changed');
    if (previous.health === 'healthy') requireValue(current.health === 'healthy', 'existing_container_unhealthy');
  }
  assertDaemonIdentity(before.daemon, after.daemon);
}

module.exports = { RELEASE, ARCHIVE, ARCHIVE_BYTES, ARCHIVE_SHA512, RUNTIME_PATH,
  planConfiguration, assertUnchangedConfiguration, assertDaemonIdentity, assertProductionUnchanged };
