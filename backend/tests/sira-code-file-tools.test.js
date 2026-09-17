'use strict';

/**
 * SiraCode jailed read / write / edit — size caps, Spanish errors, path jail.
 * OpenCode file-tool contract; native rewrite, no vendor dump, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspace, jailPath, jailRealPath, MAX_FILE_BYTES } = require('../src/services/sira-code/workspace');
const { executeTool, TOOL_DEFINITIONS } = require('../src/services/sira-code/tools');
const {
  ERRORS,
  looksBinary,
  replaceUnique,
  countOccurrences,
  formatReadOutput,
  DEFAULT_READ_LIMIT,
} = require('../src/services/sira-code/file-tools');
const { authorizeTool } = require('../src/services/sira-code/permissions');
const { resolveSessionPermission } = require('../src/services/sira-code/permission-resume');

function session(agentId, workspace, extra = {}) {
  return { agentId, workspace, permission: 'default', ...extra };
}

async function withWorkspace(id, fn) {
  const workspace = await createWorkspace(id);
  try {
    return await fn(workspace);
  } finally {
    await workspace.destroy();
  }
}

test('TOOL_DEFINITIONS expose read, write and edit', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.function.name);
  assert.ok(names.includes('read'));
  assert.ok(names.includes('write'));
  assert.ok(names.includes('edit'));
});

test('replaceUnique swaps one occurrence and keeps $ literal', () => {
  assert.equal(replaceUnique('price=cost', 'cost', '$& + $$'), 'price=$& + $$');
  assert.equal(replaceUnique('aa', 'a', 'b', { replaceAll: true }), 'bb');
  assert.equal(countOccurrences('aba', 'a'), 2);
});

test('replaceUnique refuses miss, ambiguous, identical and empty old_str', () => {
  assert.throws(() => replaceUnique('solo', 'nope', 'x'), /no aparece/);
  assert.throws(() => replaceUnique('xx', 'x', 'y'), /más de una vez/);
  assert.throws(() => replaceUnique('ab', 'ab', 'ab'), /idénticos/);
  assert.throws(() => replaceUnique('ab', '', 'x'), /obligatorio/);
});

test('looksBinary flags NUL bytes and known extensions', () => {
  assert.equal(looksBinary(Buffer.from('hola')), false);
  assert.equal(looksBinary(Buffer.from([0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.from('abc'), 'shot.png'), true);
  assert.equal(looksBinary(Buffer.from('abc'), 'nota.txt'), false);
});

test('formatReadOutput numbers lines in Spanish from a 1-indexed offset', () => {
  const out = formatReadOutput(['uno', 'dos'], { offset: 3, totalLines: 10, truncated: true });
  assert.match(out, /Línea 3: uno/);
  assert.match(out, /Línea 4: dos/);
  assert.match(out, /Usa offset=5/);
});

test('read returns numbered lines and raw text', async () => {
  await withWorkspace('sc-ft-read', async (workspace) => {
    await workspace.writeFile('nota.txt', 'hola\nmundo');
    const result = await executeTool(session('construir', workspace), 'read', { path: 'nota.txt' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, 'hola\nmundo');
    assert.match(result.content, /Línea 1: hola/);
    assert.match(result.content, /Línea 2: mundo/);
    assert.equal(result.totalLines, 2);
    assert.equal(result.truncated, false);
  });
});

test('read honors 1-indexed offset and limit', async () => {
  await withWorkspace('sc-ft-offset', async (workspace) => {
    await workspace.writeFile('n.txt', 'a\nb\nc\nd');
    const result = await executeTool(session('construir', workspace), 'read', {
      path: 'n.txt',
      offset: 2,
      limit: 2,
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /Línea 2: b/);
    assert.match(result.content, /Línea 3: c/);
    assert.equal(/Línea 1:/.test(result.content), false);
    assert.equal(result.truncated, true);
    assert.match(result.content, /Usa offset=4/);
  });
});

test('read missing path and missing file are Spanish', async () => {
  await withWorkspace('sc-ft-read-err', async (workspace) => {
    const missingPath = await executeTool(session('construir', workspace), 'read', {});
    assert.equal(missingPath.ok, false);
    assert.equal(missingPath.code, 'validation');
    assert.equal(missingPath.error, ERRORS.validation_path);
    const missing = await executeTool(session('construir', workspace), 'read', { path: 'nope.txt' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'not_found');
    assert.equal(missing.error, ERRORS.not_found);
  });
});

test('read refuses a directory and an offset past the end', async () => {
  await withWorkspace('sc-ft-dir', async (workspace) => {
    await workspace.writeFile('sub/a.txt', 'x');
    const dir = await executeTool(session('construir', workspace), 'read', { path: 'sub' });
    assert.equal(dir.ok, false);
    assert.equal(dir.code, 'not_a_file');
    assert.equal(dir.error, ERRORS.not_a_file);
    const range = await executeTool(session('construir', workspace), 'read', {
      path: 'sub/a.txt',
      offset: 9,
    });
    assert.equal(range.ok, false);
    assert.equal(range.code, 'offset_range');
    assert.match(range.error, /fuera de rango/);
  });
});

test('read refuses binary and oversized files', async () => {
  await withWorkspace('sc-ft-bin', async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'blob.bin'), Buffer.from([0x00, 0x7f, 0x01]));
    const binary = await executeTool(session('construir', workspace), 'read', { path: 'blob.bin' });
    assert.equal(binary.ok, false);
    assert.equal(binary.code, 'binary');
    assert.equal(binary.error, ERRORS.binary);
    const fat = path.join(workspace.root, 'fat.txt');
    const fd = fs.openSync(fat, 'w');
    fs.writeSync(fd, Buffer.alloc(MAX_FILE_BYTES + 8, 0x61));
    fs.closeSync(fd);
    const huge = await executeTool(session('construir', workspace), 'read', { path: 'fat.txt' });
    assert.equal(huge.ok, false);
    assert.equal(huge.code, 'file_too_large');
    assert.equal(huge.error, ERRORS.file_too_large);
  });
});

test('read accepts filePath alias used by the OpenCode contract', async () => {
  await withWorkspace('sc-ft-alias', async (workspace) => {
    await workspace.writeFile('ok.txt', 'sí');
    const result = await executeTool(session('construir', workspace), 'read', { filePath: 'ok.txt' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, 'sí');
  });
});

test('write creates nested UTF-8 files inside the jail', async () => {
  await withWorkspace('sc-ft-write', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'write', {
      path: 'src/app.js',
      content: 'const n = 1;',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.path, 'src/app.js');
    assert.match(result.content, /wrote src\/app\.js/);
    assert.equal(await workspace.readFile('src/app.js'), 'const n = 1;');
  });
});

test('write missing path and oversized payload are Spanish', async () => {
  await withWorkspace('sc-ft-write-err', async (workspace) => {
    const missing = await executeTool(session('construir', workspace), 'write', { content: 'x' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'validation');
    assert.equal(missing.error, ERRORS.validation_path);
    const huge = await executeTool(session('construir', workspace), 'write', {
      path: 'big.txt',
      content: 'x'.repeat(MAX_FILE_BYTES + 1),
    });
    assert.equal(huge.ok, false);
    assert.equal(huge.code, 'file_too_large');
    assert.equal(fs.existsSync(path.join(workspace.root, 'big.txt')), false);
  });
});

test('write overwrites an existing file', async () => {
  await withWorkspace('sc-ft-overwrite', async (workspace) => {
    await workspace.writeFile('a.txt', 'old');
    const result = await executeTool(session('construir', workspace), 'write', {
      path: 'a.txt',
      content: 'new',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('a.txt'), 'new');
  });
});

test('edit replaces a unique span and preserves $ sequences', async () => {
  await withWorkspace('sc-ft-edit', async (workspace) => {
    await workspace.writeFile('pay.js', 'const n = cost;');
    const result = await executeTool(session('construir', workspace), 'edit', {
      path: 'pay.js',
      old_str: 'cost',
      new_str: '$& + $$',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('pay.js'), 'const n = $& + $$;');
    assert.equal(result.replacements, 1);
  });
});

test('edit reports miss and ambiguous in Spanish without writing', async () => {
  await withWorkspace('sc-ft-edit-err', async (workspace) => {
    await workspace.writeFile('dup.txt', 'x\nx\n');
    const miss = await executeTool(session('construir', workspace), 'edit', {
      path: 'dup.txt',
      old_str: 'zzz',
      new_str: 'y',
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, 'edit_miss');
    assert.equal(miss.error, ERRORS.edit_miss);
    const amb = await executeTool(session('construir', workspace), 'edit', {
      path: 'dup.txt',
      old_str: 'x',
      new_str: 'y',
    });
    assert.equal(amb.ok, false);
    assert.equal(amb.code, 'edit_ambiguous');
    assert.equal(amb.error, ERRORS.edit_ambiguous);
    assert.equal(await workspace.readFile('dup.txt'), 'x\nx\n');
  });
});

test('edit replaceAll updates every occurrence', async () => {
  await withWorkspace('sc-ft-all', async (workspace) => {
    await workspace.writeFile('t.txt', 'aa-aa');
    const result = await executeTool(session('construir', workspace), 'edit', {
      path: 't.txt',
      old_str: 'aa',
      new_str: 'bb',
      replaceAll: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('t.txt'), 'bb-bb');
    assert.equal(result.replacements, 2);
  });
});

test('edit accepts oldString/newString aliases and refuses empty old_str', async () => {
  await withWorkspace('sc-ft-edit-alias', async (workspace) => {
    await workspace.writeFile('a.txt', 'hola');
    const empty = await executeTool(session('construir', workspace), 'edit', {
      path: 'a.txt',
      old_str: '',
      new_str: 'x',
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'validation');
    const result = await executeTool(session('construir', workspace), 'edit', {
      path: 'a.txt',
      oldString: 'hola',
      newString: 'ciao',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('a.txt'), 'ciao');
  });
});

test('edit preserves CRLF when the file uses CRLF', async () => {
  await withWorkspace('sc-ft-crlf', async (workspace) => {
    await workspace.writeFile('win.txt', 'uno\r\ndos\r\n');
    const result = await executeTool(session('construir', workspace), 'edit', {
      path: 'win.txt',
      old_str: 'dos',
      new_str: 'tres',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('win.txt'), 'uno\r\ntres\r\n');
  });
});

test('path escape via .. and absolute host paths is blocked', async () => {
  await withWorkspace('sc-ft-escape', async (workspace) => {
    const outside = path.join(os.tmpdir(), `sc-ft-host-${process.pid}.txt`);
    fs.writeFileSync(outside, 'LEAK_HOST');
    try {
      for (const tool of ['read', 'write', 'edit']) {
        const args = tool === 'edit'
          ? { path: '../escape.txt', old_str: 'a', new_str: 'b' }
          : tool === 'write'
            ? { path: '../escape.txt', content: 'no' }
            : { path: '../escape.txt' };
        const result = await executeTool(session('construir', workspace), tool, args);
        assert.equal(result.ok, false, tool);
        assert.equal(result.code, 'path_traversal', result);
        assert.equal(result.error, ERRORS.path_traversal);
      }
      const abs = await executeTool(session('construir', workspace), 'read', { path: outside });
      assert.equal(abs.ok, false);
      assert.equal(abs.code, 'path_traversal');
    } finally {
      fs.unlinkSync(outside);
    }
  });
});

test('null byte in the path is rejected', async () => {
  await withWorkspace('sc-ft-nul', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'read', { path: 'ok\0.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_invalid');
  });
});

test('symlink that points outside the workspace is blocked on read and write', async () => {
  await withWorkspace('sc-ft-symlink', async (workspace) => {
    const outside = path.join(os.tmpdir(), `sc-ft-sym-${process.pid}.txt`);
    fs.writeFileSync(outside, 'LEAK_LINK');
    const link = path.join(workspace.root, 'leak.txt');
    fs.symlinkSync(outside, link);
    try {
      const read = await executeTool(session('construir', workspace), 'read', { path: 'leak.txt' });
      assert.equal(read.ok, false);
      assert.equal(read.code, 'path_traversal');
      const write = await executeTool(session('construir', workspace), 'write', {
        path: 'leak.txt',
        content: 'overwrite-host',
      });
      assert.equal(write.ok, false);
      assert.equal(write.code, 'path_traversal');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'LEAK_LINK');
    } finally {
      fs.unlinkSync(outside);
    }
  });
});

test('jailPath and jailRealPath reject lexical escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ft-jail-'));
  try {
    assert.throws(() => jailPath(root, '../x'), /fuera del workspace/);
    await assert.rejects(() => jailRealPath(root, '../../etc/passwd'), /fuera del workspace/);
    const inside = await jailRealPath(root, 'a/b.txt');
    assert.ok(inside.startsWith(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planificar can read but cannot write or edit', async () => {
  await withWorkspace('sc-ft-plan', async (workspace) => {
    await workspace.writeFile('visible.txt', 'ok');
    const read = await executeTool(session('planificar', workspace), 'read', { path: 'visible.txt' });
    assert.equal(read.ok, true, read.error);
    assert.equal(read.text, 'ok');
    const write = await executeTool(session('planificar', workspace), 'write', {
      path: 'nuevo.txt',
      content: 'no',
    });
    assert.equal(write.ok, false);
    assert.equal(write.permission.denied, true);
    assert.equal(fs.existsSync(path.join(workspace.root, 'nuevo.txt')), false);
    const edit = await executeTool(session('planificar', workspace), 'edit', {
      path: 'visible.txt',
      old_str: 'ok',
      new_str: 'no',
    });
    assert.equal(edit.ok, false);
    assert.equal(edit.permission.denied, true);
    assert.equal(await workspace.readFile('visible.txt'), 'ok');
  });
});

test('planificar stay deny even after an approved permission-resume', async () => {
  await withWorkspace('sc-ft-plan-resume', async (workspace) => {
    const write = await executeTool(
      session('planificar', workspace),
      'write',
      { path: 'x.txt', content: 'no' },
      { approved: true },
    );
    assert.equal(write.ok, false);
    assert.equal(write.permission.denied, true);
    const matrix = authorizeTool('planificar', 'edit', { approved: true, permission: 'default' });
    assert.equal(matrix.denied, true);
    assert.equal(matrix.needsPermission, false);
  });
});

test('construir writes immediately under default permission', async () => {
  await withWorkspace('sc-ft-build', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'write', {
      path: 'ok.txt',
      content: 'sí',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('ok.txt'), 'sí');
  });
});

test('composer Solo lectura blocks construir writes', async () => {
  await withWorkspace('sc-ft-readonly', async (workspace) => {
    const result = await executeTool(
      session('construir', workspace, { permission: 'read' }),
      'write',
      { path: 'blocked.txt', content: 'no' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'composer_read_only');
    assert.match(result.error, /Solo lectura/);
    assert.equal(fs.existsSync(path.join(workspace.root, 'blocked.txt')), false);
  });
});

test('composer Protegido asks, then permission-resume writes in construir', async () => {
  await withWorkspace('sc-ft-prot', async (workspace) => {
    const pending = await executeTool(
      session('construir', workspace, { permission: 'protected' }),
      'write',
      { path: 'nota.txt', content: 'revisado' },
    );
    assert.equal(pending.ok, false);
    assert.equal(pending.code, 'permission_required');
    assert.equal(fs.existsSync(path.join(workspace.root, 'nota.txt')), false);

    const sess = {
      id: 'sc_ft_prot',
      agentId: 'construir',
      workspace,
      permission: 'protected',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_1', { tool: 'write', name: 'write', args: { path: 'nota.txt', content: 'revisado' } }],
      ]),
      events: [],
      messages: [],
    };
    const resolved = await resolveSessionPermission(sess, 'perm_1', 'allow');
    assert.equal(resolved.executed, true);
    assert.equal(resolved.remembered, false);
    assert.equal(await workspace.readFile('nota.txt'), 'revisado');
  });
});

test('always grant remembers write for later construir turns', async () => {
  await withWorkspace('sc-ft-always', async (workspace) => {
    const sess = {
      id: 'sc_ft_always',
      agentId: 'construir',
      workspace,
      permission: 'protected',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_a', { tool: 'edit', name: 'edit', args: { path: 'a.txt', old_str: 'old', new_str: 'new' } }],
      ]),
      events: [],
      messages: [],
    };
    await workspace.writeFile('a.txt', 'old');
    const resolved = await resolveSessionPermission(sess, 'perm_a', 'always');
    assert.equal(resolved.executed, true);
    assert.equal(resolved.remembered, true);
    assert.ok(sess.permissionGrants.has('edit'));
    const again = await executeTool(sess, 'edit', { path: 'a.txt', old_str: 'new', new_str: 'later' });
    assert.equal(again.ok, true, again.error);
    assert.equal(await workspace.readFile('a.txt'), 'later');
  });
});

test('deny on permission-resume does not write', async () => {
  await withWorkspace('sc-ft-deny', async (workspace) => {
    const sess = {
      id: 'sc_ft_deny',
      agentId: 'construir',
      workspace,
      permission: 'protected',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_d', { tool: 'write', name: 'write', args: { path: 'no.txt', content: 'x' } }],
      ]),
      events: [],
      messages: [],
    };
    const resolved = await resolveSessionPermission(sess, 'perm_d', 'deny');
    assert.equal(resolved.executed, false);
    assert.equal(resolved.decision, 'deny');
    assert.equal(fs.existsSync(path.join(workspace.root, 'no.txt')), false);
  });
});

test('permission-resume cannot unlock planificar write', async () => {
  await withWorkspace('sc-ft-plan-unlock', async (workspace) => {
    const sess = {
      id: 'sc_ft_plan_unlock',
      agentId: 'planificar',
      workspace,
      permission: 'default',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_p', { tool: 'write', name: 'write', args: { path: 'no.txt', content: 'x' } }],
      ]),
      events: [],
      messages: [],
    };
    const resolved = await resolveSessionPermission(sess, 'perm_p', 'always');
    assert.equal(resolved.executed, false);
    assert.equal(resolved.allowed, false);
    assert.equal(fs.existsSync(path.join(workspace.root, 'no.txt')), false);
  });
});

test('read_file / write_file / str_replace aliases map through the matrix', () => {
  assert.equal(authorizeTool('construir', 'read_file').tool, 'read');
  assert.equal(authorizeTool('construir', 'write_file').allowed, true);
  assert.equal(authorizeTool('planificar', 'str_replace').denied, true);
  assert.equal(authorizeTool('construir', 'edit_file').writable, true);
});

test('DEFAULT_READ_LIMIT stays at the OpenCode-sized 2000 lines', () => {
  assert.equal(DEFAULT_READ_LIMIT, 2000);
});

test('errors stay Spanish and vendor-free', () => {
  const blob = JSON.stringify(ERRORS);
  assert.equal(/deepseek|openrouter|model_id|sk-|Bearer/i.test(blob), false);
  assert.match(ERRORS.path_traversal, /fuera del workspace/);
  assert.match(ERRORS.file_too_large, /demasiado grande/);
  assert.match(ERRORS.binary, /binario/);
});
