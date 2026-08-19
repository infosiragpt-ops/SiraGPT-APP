/**
 * Tests for host-file-tool.
 *
 * Run: node --test backend/tests/host-file-tool.test.js
 */

const assert = require('node:assert');
const { describe, it } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostFileModule = require('../src/services/agents/host-file-tool');
const internal = hostFileModule._internal;

function makeProjectTempDir() {
  const base = path.join(os.homedir(), 'Desktop', 'sira-projects');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'host-file-tool-'));
}

describe('host-file-tool', () => {
  it('resolves only paths inside allowed project roots', () => {
    const allowed = path.join(os.homedir(), 'Desktop', 'sira-projects', 'repo', 'README.md');
    assert.strictEqual(internal.resolveSafePath(allowed), allowed);
    assert.strictEqual(internal.resolveSafePath('/etc/passwd'), null);
    assert.strictEqual(internal.resolveSafePath('../escape.txt', os.tmpdir()), null);
  });

  it('blocks secret-like files', async () => {
    const result = await hostFileModule.hostFile({
      action: 'read',
      path: path.join(os.homedir(), 'Desktop', 'sira-projects', 'repo', '.env'),
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /secretos|llaves/i);
  });

  it('writes, reads and appends text atomically', async () => {
    const dir = makeProjectTempDir();
    const file = path.join(dir, 'notes.txt');

    const write = await hostFileModule.hostFile({ action: 'write', path: file, content: 'hola' });
    assert.strictEqual(write.ok, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hola');

    const append = await hostFileModule.hostFile({ action: 'append', path: file, content: '\nLuis' });
    assert.strictEqual(append.ok, true);

    const read = await hostFileModule.hostFile({ action: 'read', path: file });
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.content, 'hola\nLuis');
    assert.strictEqual(read.truncated, false);
  });

  it('replaces exact text with occurrence guard', async () => {
    const dir = makeProjectTempDir();
    const file = path.join(dir, 'code.js');
    fs.writeFileSync(file, 'const mode = "old";\nconst other = "old";\n');

    const mismatch = await hostFileModule.hostFile({
      action: 'replace',
      path: file,
      oldText: '"old"',
      newText: '"new"',
      expectedOccurrences: 1,
    });
    assert.strictEqual(mismatch.ok, false);
    assert.match(mismatch.error, /esperaban 1 ocurrencias/i);

    const replaced = await hostFileModule.hostFile({
      action: 'replace',
      path: file,
      oldText: '"old"',
      newText: '"new"',
      replaceAll: true,
      expectedOccurrences: 2,
    });
    assert.strictEqual(replaced.ok, true);
    assert.strictEqual(replaced.replaced, 2);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const mode = "new";\nconst other = "new";\n');
  });

  it('tool definition exposes required schema', () => {
    assert.strictEqual(hostFileModule.hostFileTool.name, 'host_file');
    assert.ok(hostFileModule.hostFileTool.parameters.properties.action);
    assert.ok(hostFileModule.hostFileTool.parameters.required.includes('action'));
    assert.ok(hostFileModule.hostFileTool.parameters.required.includes('path'));
  });
});
