'use strict';

/**
 * Disk / volume DEV driver (Phase 4e). Same session interface as
 * memory + docker, files on a jailed host directory. No Docker daemon.
 */

const { fail } = require('./errors');
const { createMemoryDriver } = require('./memory-driver');
const { jailRelPath } = require('./path-jail');

function createVolumeDriver(opts = {}) {
  const volume = opts.volume;
  const memory = createMemoryDriver();

  return {
    kind: 'volume',
    volume,

    async createSession(session) {
      session.files = null;
      session.containerName = null;
      session.volumePath = volume.ensure(session);
      return session;
    },

    async exec(session, command, execOpts) {
      return memory.exec(session, command, execOpts);
    },

    async readFile(session, relPath) {
      return volume.readFile(session.id, relPath);
    },

    async writeFile(session, relPath, content) {
      const rel = jailRelPath(relPath);
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      if (buf.length > session.limits.maxFileBytes) fail('E_QUOTA', 'El archivo supera el tope.');
      volume.assertCanWrite(session, rel, buf.length);
      return volume.writeFile(session.id, rel, buf);
    },

    async listFiles(session, relDir = '.') {
      return volume.walkFiles(session.id, relDir);
    },

    async destroy(session) {
      if (session && session.id) volume.remove(session.id);
    },
  };
}

module.exports = { createVolumeDriver };
