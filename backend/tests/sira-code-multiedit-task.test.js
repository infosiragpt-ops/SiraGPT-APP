'use strict';

/**
 * SiraCode multiedit (batched jailed edits) + task spawn stub.
 * OpenCode contract, native rewrite — no vendor dump, Spanish errors,
 * Planificar read-only. Offline: temp workspace + injected enqueue.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool, TOOL_DEFINITIONS } = require('../src/services/sira-code/tools');
const {
  ERRORS,
  MAX_MULTI_EDITS,
  MAX_MULTI_FILES,
  normalizeEdits,
  applyEditsInMemory,
  replaceUnique,
} = require('../src/services/sira-code/file-tools');
const {
  ERRORS: TASK_ERRORS,
  MAX_SPAWN_DEPTH,
  resolveSubagentType,
  defaultDescription,
} = require('../src/services/sira-code/task-spawn');
const { authorizeTool } = require('../src/services/sira-code/permissions');
const { authorizeComposerTool } = require('../src/services/composer-permission');
const { resolveSessionPermission } = require('../src/services/sira-code/permission-resume');

function session(agentId, workspace, extra = {}) {
  return {
    id: extra.id || `sc_${agentId}`,
    userId: extra.userId || 'user-1',
    agentId,
    workspace,
    permission: extra.permission || 'default',
    ...extra,
  };
}

async function withWorkspace(id, fn) {
  const workspace = await createWorkspace(id);
  try {
    return await fn(workspace);
  } finally {
    await workspace.destroy();
  }
}

function names() {
  return TOOL_DEFINITIONS.map((item) => item.function.name);
}

test('TOOL_DEFINITIONS expose multiedit and task', () => {
  assert.ok(names().includes('multiedit'));
  assert.ok(names().includes('task'));
  const multi = TOOL_DEFINITIONS.find((item) => item.function.name === 'multiedit');
  assert.ok(multi.function.parameters.required.includes('edits'));
  const task = TOOL_DEFINITIONS.find((item) => item.function.name === 'task');
  assert.ok(task.function.parameters.required.includes('prompt'));
  assert.ok(task.function.parameters.required.includes('subagent_type'));
});

test('normalizeEdits accepts Claude-style file_path plus edits[]', () => {
  const out = normalizeEdits({
    file_path: 'a.js',
    edits: [{ old_str: 'x', new_str: 'y' }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.edits[0].path, 'a.js');
  assert.equal(out.edits[0].old_str, 'x');
});

test('normalizeEdits accepts per-edit paths and OpenCode aliases', () => {
  const out = normalizeEdits({
    changes: [
      { filePath: 'a.ts', oldString: 'old', newString: 'new' },
      { path: 'b.ts', old: 'p', new: 'q', replace_all: true },
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.edits.length, 2);
  assert.equal(out.edits[0].path, 'a.ts');
  assert.equal(out.edits[1].replaceAll, true);
});

test('normalizeEdits rejects empty, non-list and missing old_str in Spanish', () => {
  assert.equal(normalizeEdits({}).error, ERRORS.validation_edits);
  assert.equal(normalizeEdits({ edits: 'no' }).error, ERRORS.validation_edits);
  assert.equal(normalizeEdits({ edits: [] }).error, ERRORS.validation_edits_empty);
  assert.equal(normalizeEdits({ edits: [{ path: 'a.txt', new_str: 'x' }] }).error, ERRORS.validation_old);
  assert.equal(normalizeEdits({ edits: [{ old_str: 'x', new_str: 'y' }] }).error, ERRORS.validation_path);
});

test('normalizeEdits rejects oversized batches', () => {
  const tooMany = Array.from({ length: MAX_MULTI_EDITS + 1 }, (_, i) => ({
    path: 'a.txt',
    old_str: `k${i}`,
    new_str: 'v',
  }));
  assert.equal(normalizeEdits({ edits: tooMany }).error, ERRORS.validation_edits_limit);
  const files = Array.from({ length: MAX_MULTI_FILES + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    old_str: 'a',
    new_str: 'b',
  }));
  assert.equal(normalizeEdits({ edits: files }).error, ERRORS.validation_files_limit);
});

test('applyEditsInMemory applies sequential unique replacements', () => {
  const out = applyEditsInMemory('alpha beta', [
    { old_str: 'alpha', new_str: 'uno' },
    { old_str: 'beta', new_str: 'dos' },
  ]);
  assert.equal(out.text, 'uno dos');
  assert.equal(out.replacements, 2);
  assert.equal(replaceUnique('aa', 'a', 'b', { replaceAll: true }), 'bb');
});

test('applyEditsInMemory refuses a miss so the batch stays atomic', () => {
  assert.throws(
    () => applyEditsInMemory('solo', [
      { old_str: 'solo', new_str: 'ok' },
      { old_str: 'falta', new_str: 'x' },
    ]),
    /no aparece/,
  );
});

test('construir multiedit writes two jailed files atomically', async () => {
  await withWorkspace('sc-me-two', async (workspace) => {
    await workspace.writeFile('a.txt', 'hola');
    await workspace.writeFile('b.txt', 'mundo');
    const result = await executeTool(session('construir', workspace), 'multiedit', {
      edits: [
        { path: 'a.txt', old_str: 'hola', new_str: 'ciao' },
        { path: 'b.txt', old_str: 'mundo', new_str: 'terra' },
      ],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('a.txt'), 'ciao');
    assert.equal(await workspace.readFile('b.txt'), 'terra');
    assert.equal(result.replacements, 2);
    assert.deepEqual(result.paths, ['a.txt', 'b.txt']);
    assert.match(result.content, /editados/);
  });
});

test('multiedit applies sequential edits on the same file', async () => {
  await withWorkspace('sc-me-seq', async (workspace) => {
    await workspace.writeFile('n.txt', 'uno dos tres');
    const result = await executeTool(session('construir', workspace), 'multiedit', {
      path: 'n.txt',
      edits: [
        { old_str: 'uno', new_str: '1' },
        { old_str: 'dos', new_str: '2' },
      ],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('n.txt'), '1 2 tres');
  });
});

test('multiedit honors replaceAll inside the batch', async () => {
  await withWorkspace('sc-me-all', async (workspace) => {
    await workspace.writeFile('rep.txt', 'x x x');
    const result = await executeTool(session('construir', workspace), 'multiedit', {
      edits: [{ path: 'rep.txt', old_str: 'x', new_str: 'y', replaceAll: true }],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(await workspace.readFile('rep.txt'), 'y y y');
    assert.equal(result.replacements, 3);
  });
});

test('multiedit miss writes nothing (atomic)', async () => {
  await withWorkspace('sc-me-miss', async (workspace) => {
    await workspace.writeFile('keep.txt', 'ok');
    await workspace.writeFile('other.txt', 'stay');
    const result = await executeTool(session('construir', workspace), 'multiedit', {
      edits: [
        { path: 'keep.txt', old_str: 'ok', new_str: 'changed' },
        { path: 'other.txt', old_str: 'nope', new_str: 'x' },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'edit_miss');
    assert.equal(await workspace.readFile('keep.txt'), 'ok');
    assert.equal(await workspace.readFile('other.txt'), 'stay');
  });
});

test('multiedit refuses path traversal in Spanish', async () => {
  await withWorkspace('sc-me-jail', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'multiedit', {
      edits: [{ path: '../secret.txt', old_str: 'a', new_str: 'b' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_traversal');
    assert.match(result.error, /fuera del workspace/);
  });
});

test('planificar cannot multiedit', async () => {
  await withWorkspace('sc-me-plan', async (workspace) => {
    await workspace.writeFile('visible.txt', 'ok');
    const result = await executeTool(session('planificar', workspace), 'multiedit', {
      edits: [{ path: 'visible.txt', old_str: 'ok', new_str: 'no' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.permission.denied, true);
    assert.equal(await workspace.readFile('visible.txt'), 'ok');
  });
});

test('planificar stay deny for multiedit even after approved resume', async () => {
  await withWorkspace('sc-me-plan-resume', async (workspace) => {
    await workspace.writeFile('x.txt', 'ok');
    const result = await executeTool(
      session('planificar', workspace),
      'multiedit',
      { edits: [{ path: 'x.txt', old_str: 'ok', new_str: 'no' }] },
      { approved: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.permission.denied, true);
    assert.equal(authorizeTool('planificar', 'multiedit', { approved: true }).denied, true);
    assert.equal(await workspace.readFile('x.txt'), 'ok');
  });
});

test('composer Solo lectura blocks construir multiedit', async () => {
  await withWorkspace('sc-me-ro', async (workspace) => {
    await workspace.writeFile('a.txt', 'ok');
    const result = await executeTool(
      session('construir', workspace, { permission: 'read' }),
      'multiedit',
      { edits: [{ path: 'a.txt', old_str: 'ok', new_str: 'no' }] },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'composer_read_only');
    assert.match(result.error, /Solo lectura/);
    assert.equal(await workspace.readFile('a.txt'), 'ok');
  });
});

test('composer Protegido asks, then permission-resume applies the batch', async () => {
  await withWorkspace('sc-me-prot', async (workspace) => {
    await workspace.writeFile('nota.txt', 'old');
    const pending = await executeTool(
      session('construir', workspace, { permission: 'protected' }),
      'multiedit',
      { edits: [{ path: 'nota.txt', old_str: 'old', new_str: 'new' }] },
    );
    assert.equal(pending.ok, false);
    assert.equal(pending.code, 'permission_required');
    assert.equal(await workspace.readFile('nota.txt'), 'old');

    const sess = session('construir', workspace, {
      id: 'sc_me_prot',
      permission: 'protected',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_m', {
          tool: 'multiedit',
          name: 'multiedit',
          args: { edits: [{ path: 'nota.txt', old_str: 'old', new_str: 'new' }] },
        }],
      ]),
      events: [],
      messages: [],
    });
    const resolved = await resolveSessionPermission(sess, 'perm_m', 'allow');
    assert.equal(resolved.executed, true);
    assert.equal(await workspace.readFile('nota.txt'), 'new');
  });
});

test('multi_edit and batch_edit aliases map through the matrix', () => {
  assert.equal(authorizeTool('construir', 'multi_edit').tool, 'multiedit');
  assert.equal(authorizeTool('construir', 'batch_edit').allowed, true);
  assert.equal(authorizeTool('planificar', 'multi_edit').denied, true);
  assert.equal(authorizeTool('construir', 'multiedit').writable, true);
  assert.equal(authorizeComposerTool('read', 'batch_edit').reason, 'composer_read_only');
});

test('task queues a child job via injected agent-task APIs', async () => {
  await withWorkspace('sc-tk-q', async (workspace) => {
    const enqueued = [];
    const records = [];
    const result = await executeTool(
      session('construir', workspace, { userId: 'u-9' }),
      'task',
      { description: 'busca docs', prompt: 'encuentra TODOs', subagent_type: 'general' },
      {
        enqueue: async (payload, opts) => {
          enqueued.push({ payload, opts });
          return { id: payload.taskId };
        },
        createRecord: (payload) => {
          records.push(payload);
          return { taskId: payload.taskId, status: 'queued' };
        },
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.status, 'queued');
    assert.equal(result.subagent, 'general');
    assert.equal(enqueued.length, 1);
    assert.equal(records.length, 1);
    assert.equal(enqueued[0].payload.taskType, 'sira_code_subagent');
    assert.equal(enqueued[0].payload.source, 'sira-code:task');
    assert.equal(enqueued[0].payload.userId, 'u-9');
    assert.equal(enqueued[0].payload.prompt, 'encuentra TODOs');
    assert.match(result.content, /tarea encolada/);
    assert.match(result.content, /agente: general/);
  });
});

test('task payload carries parent session and does not run an LLM loop', async () => {
  await withWorkspace('sc-tk-parent', async (workspace) => {
    let payload;
    const sess = session('construir', workspace, { id: 'sc_parent', taskId: 'parent-1' });
    await executeTool(sess, 'task', {
      prompt: 'explora src',
      subagent_type: 'explore',
    }, {
      enqueue: async (row) => { payload = row; return { id: row.taskId }; },
      createRecord: (row) => row,
    });
    assert.equal(payload.parentSessionId, 'sc_parent');
    assert.equal(payload.parentTaskId, 'parent-1');
    assert.equal(payload.metadata.subagent, 'general');
    assert.equal(payload.thinking, 'low');
    assert.ok(Array.isArray(sess.childTasks));
    assert.equal(sess.childTasks[0].status, 'queued');
  });
});

test('planificar can spawn a read-only general child', async () => {
  await withWorkspace('sc-tk-plan-ok', async (workspace) => {
    const result = await executeTool(
      session('planificar', workspace),
      'task',
      { prompt: 'lee el README', subagent_type: 'general' },
      {
        enqueue: async (payload) => ({ id: payload.taskId }),
        createRecord: (payload) => payload,
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.subagent, 'general');
  });
});

test('planificar cannot spawn construir', async () => {
  await withWorkspace('sc-tk-plan-no', async (workspace) => {
    let called = 0;
    const result = await executeTool(
      session('planificar', workspace),
      'task',
      { prompt: 'reescribe el módulo', subagent_type: 'construir' },
      {
        enqueue: async () => { called += 1; return { id: 'x' }; },
        createRecord: () => ({}),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'planificar_readonly');
    assert.equal(result.error, TASK_ERRORS.planificar_readonly);
    assert.equal(called, 0);
  });
});

test('construir can spawn construir and resolve build alias', async () => {
  await withWorkspace('sc-tk-build', async (workspace) => {
    const result = await executeTool(
      session('construir', workspace),
      'task',
      { prompt: 'aplica el parche', subagent_type: 'build' },
      {
        enqueue: async (payload) => ({ id: payload.taskId }),
        createRecord: (payload) => payload,
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.subagent, 'construir');
    assert.equal(resolveSubagentType('build'), 'construir');
    assert.equal(resolveSubagentType('explore'), 'general');
    assert.equal(resolveSubagentType('plan'), 'planificar');
  });
});

test('task validation errors stay Spanish', async () => {
  await withWorkspace('sc-tk-val', async (workspace) => {
    const noPrompt = await executeTool(
      session('construir', workspace),
      'task',
      { subagent_type: 'general' },
      { enqueue: async () => ({}), createRecord: () => ({}) },
    );
    assert.equal(noPrompt.code, 'validation');
    assert.equal(noPrompt.error, TASK_ERRORS.validation_prompt);
    const badAgent = await executeTool(
      session('construir', workspace),
      'task',
      { prompt: 'hola', subagent_type: 'desconocido' },
      { enqueue: async () => ({}), createRecord: () => ({}) },
    );
    assert.equal(badAgent.error, TASK_ERRORS.validation_subagent);
    const noUser = await executeTool(
      session('construir', workspace, { userId: '' }),
      'task',
      { prompt: 'hola', subagent_type: 'general' },
      { enqueue: async () => ({}), createRecord: () => ({}) },
    );
    assert.equal(noUser.error, TASK_ERRORS.user_required);
    const badId = await executeTool(
      session('construir', workspace),
      'task',
      { prompt: 'hola', subagent_type: 'general', task_id: '??' },
      { enqueue: async () => ({}), createRecord: () => ({}) },
    );
    assert.equal(badId.error, TASK_ERRORS.validation_task_id);
  });
});

test('task_id resumes the same child id', async () => {
  await withWorkspace('sc-tk-resume', async (workspace) => {
    const ids = [];
    const sess = session('construir', workspace, {
      childTasks: [{ taskId: 'sctask_prev01', subagent: 'general', status: 'queued' }],
    });
    const result = await executeTool(sess, 'task', {
      prompt: 'sigue buscando',
      subagent_type: 'general',
      task_id: 'sctask_prev01',
    }, {
      enqueue: async (payload) => { ids.push(payload.taskId); return { id: payload.taskId }; },
      createRecord: (payload) => payload,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resumed, true);
    assert.equal(ids[0], 'sctask_prev01');
    assert.match(result.content, /reanudada/);
  });
});

test('planificar cannot resume a construir child', async () => {
  await withWorkspace('sc-tk-resume-deny', async (workspace) => {
    let called = 0;
    const result = await executeTool(
      session('planificar', workspace, {
        childTasks: [{ taskId: 'sctask_write1', subagent: 'construir' }],
      }),
      'task',
      { prompt: 'sigue', subagent_type: 'general', task_id: 'sctask_write1' },
      {
        enqueue: async () => { called += 1; return { id: 'x' }; },
        createRecord: () => ({}),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'planificar_readonly');
    assert.equal(called, 0);
  });
});

test('task refuses spawn depth beyond the cap', async () => {
  await withWorkspace('sc-tk-depth', async (workspace) => {
    const result = await executeTool(
      session('construir', workspace, { spawnDepth: MAX_SPAWN_DEPTH }),
      'task',
      { prompt: 'otro', subagent_type: 'general' },
      { enqueue: async () => ({ id: 'x' }), createRecord: () => ({}) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'spawn_depth');
    assert.equal(result.error, TASK_ERRORS.spawn_depth);
  });
});

test('enqueue failure is Spanish and does not invent a running child', async () => {
  await withWorkspace('sc-tk-fail', async (workspace) => {
    const sess = session('construir', workspace);
    const result = await executeTool(sess, 'task', {
      prompt: 'explora',
      subagent_type: 'general',
    }, {
      enqueue: async () => { throw new Error('REDIS_URL missing'); },
      createRecord: () => ({}),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'enqueue_failed');
    assert.equal(result.error, TASK_ERRORS.enqueue_failed);
    assert.equal((sess.childTasks || []).length, 0);
    assert.equal(/redis|bullmq|opencode/i.test(result.error), false);
  });
});

test('general agent cannot spawn and composer Solo lectura blocks task', async () => {
  await withWorkspace('sc-tk-deny', async (workspace) => {
    const internal = await executeTool(
      session('general', workspace),
      'task',
      { prompt: 'x', subagent_type: 'general' },
      { enqueue: async () => ({ id: 'x' }), createRecord: () => ({}) },
    );
    assert.equal(internal.ok, false);
    assert.equal(internal.permission.denied, true);

    const read = await executeTool(
      session('construir', workspace, { permission: 'read' }),
      'task',
      { prompt: 'x', subagent_type: 'general' },
      { enqueue: async () => ({ id: 'x' }), createRecord: () => ({}) },
    );
    assert.equal(read.code, 'composer_read_only');
    assert.equal(authorizeComposerTool('protected', 'task').needsPermission, true);
    assert.equal(authorizeTool('construir', 'spawn_task').tool, 'task');
  });
});

test('permission-resume deny does not enqueue a child task', async () => {
  await withWorkspace('sc-tk-resume-perm', async (workspace) => {
    let called = 0;
    const sess = session('construir', workspace, {
      permission: 'protected',
      permissionGrants: new Set(),
      pendingPermissions: new Map([
        ['perm_t', {
          tool: 'task',
          name: 'task',
          args: { prompt: 'explora', subagent_type: 'general' },
        }],
      ]),
      events: [],
      messages: [],
      enqueue: async () => { called += 1; return { id: 'x' }; },
      createRecord: () => ({}),
    });
    const resolved = await resolveSessionPermission(sess, 'perm_t', 'deny');
    assert.equal(resolved.executed, false);
    assert.equal(called, 0);
  });
});

test('defaultDescription and aliases stay vendor-free', () => {
  assert.equal(defaultDescription('busca  docs  ahora mismo por favor'), 'busca docs ahora mismo por');
  assert.equal(defaultDescription('   '), 'tarea');
  assert.equal(resolveSubagentType(''), null);
  const blob = JSON.stringify({ ...ERRORS, ...TASK_ERRORS });
  assert.equal(/deepseek|openrouter|model_id|sk-|Bearer|anomalyco/i.test(blob), false);
  assert.match(ERRORS.validation_edits, /lista/);
  assert.match(TASK_ERRORS.planificar_readonly, /lectura/);
});

test('new modules do not import vendor/opencode', () => {
  const files = [
    path.join(__dirname, '../src/services/sira-code/file-tools.js'),
    path.join(__dirname, '../src/services/sira-code/task-spawn.js'),
    path.join(__dirname, '../src/services/sira-code/tools.js'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(/require\(['"][^'"]*vendor\/opencode/.test(src), false, file);
    assert.equal(/from ['"][^'"]*vendor\/opencode/.test(src), false, file);
    assert.equal(/\beffect\b/i.test(src) === false || /not a copy/i.test(src), true);
  }
});
