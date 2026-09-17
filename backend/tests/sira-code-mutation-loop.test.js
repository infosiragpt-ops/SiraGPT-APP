'use strict';

// Real native session, loop, permissions, events and temporary filesystem.
// Only model responses are scripted; no provider/network/production acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/sira-code/engine');
const { getSession, destroySession } = require('../src/services/sira-code/session-store');

test('native loop exposes a file conflict and can re-read before a safe targeted retry', async () => {
  const created = await engine.create({ userId: 'mutation-loop-fixture' });
  const session = getSession(created.id);
  try {
    await session.workspace.writeFile('app.txt', 'title=Old\nowner=Original\n');
    const readSnapshot = session.workspace.readFileForMutation.bind(session.workspace);
    let raced = false;
    session.workspace.readFileForMutation = async (file) => {
      const snapshot = await readSnapshot(file);
      if (!raced) {
        raced = true;
        await session.workspace.writeFile(file, 'title=Old\nowner=Newer edit\n');
      }
      return snapshot;
    };
    let turn = 0;
    const result = await engine.prompt(created.id, 'Actualiza el título sin modificar el propietario.', {
      userId: 'mutation-loop-fixture',
      maxSteps: 5,
      llmTurn: async () => {
        turn += 1;
        if (turn === 2) return { text: '', toolCalls: [{ name: 'read', arguments: { path: 'app.txt' } }] };
        if (turn === 4) return { text: 'Título actualizado conservando el propietario.', toolCalls: [] };
        return { text: '', toolCalls: [{ name: 'edit', arguments: { path: 'app.txt', old_str: 'title=Old', new_str: 'title=New' } }] };
      },
    });

    assert.equal(turn, 4);
    assert.equal(result.toolResults.length, 3);
    assert.equal(result.toolResults[0].ok, false);
    assert.equal(result.toolResults[0].code, 'file_changed');
    assert.match(result.toolResults[0].content, /ERROR:/);
    assert.equal(result.toolResults[1].ok, true);
    assert.match(result.toolResults[1].content, /owner=Newer edit/);
    assert.equal(result.toolResults[2].ok, true);
    assert.equal(await session.workspace.readFile('app.txt'), 'title=New\nowner=Newer edit\n');
    assert.ok(session.events.some((event) => event.type === 'tool_result' && event.ok === false));
    assert.equal(session.events.filter((event) => event.type === 'tool_result' && event.ok === false).length, 1);
  } finally {
    await destroySession(session);
  }
});
