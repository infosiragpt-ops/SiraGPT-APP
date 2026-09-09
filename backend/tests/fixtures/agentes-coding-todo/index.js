'use strict';

/**
 * Phase 4f golden: tiny todo-app bytes + scripted harness turns.
 * Offline only. No network, no Docker, no real model.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const WORKSPACE = path.join(ROOT, 'workspace');
const PACKAGE_JSON = fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8');
const APP_JS = fs.readFileSync(path.join(WORKSPACE, 'src/app.js'), 'utf8');

const FILES = Object.freeze({
  'package.json': PACKAGE_JSON,
  'src/app.js': APP_JS,
});

const PROMPT = 'crea un todo app mínimo con package.json y src/app.js';
const DONE_TEXT = 'Todo app listo en el jail.';
const EXEC_ADD = 'node src/app.js add comprar leche';
const EXEC_ADD_ITEM = Object.freeze({ id: 1, title: 'comprar leche', done: false });

function scriptedLlm(turns) {
  let i = 0;
  return async function llmTurn() {
    const next = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
}

function writeTurns() {
  return [
    {
      text: 'Voy a crear el manifiesto.',
      toolCalls: [{
        name: 'write',
        arguments: { path: 'package.json', content: FILES['package.json'] },
      }],
    },
    {
      text: 'Ahora el CLI de todos.',
      toolCalls: [{
        name: 'write_file',
        arguments: { path: 'src/app.js', content: FILES['src/app.js'] },
      }],
    },
    { text: DONE_TEXT, toolCalls: [] },
  ];
}

function writeThenExecTurns() {
  const turns = writeTurns();
  return [
    turns[0],
    turns[1],
    {
      text: 'Pruebo add.',
      toolCalls: [{ name: 'exec', arguments: { command: EXEC_ADD } }],
    },
    { text: 'Todo app listo y probado.', toolCalls: [] },
  ];
}

function attachMemoryExec(session) {
  session.execImpl = async (cmd) => {
    const text = String(cmd || '').trim();
    if (text === EXEC_ADD) {
      return { stdout: `${JSON.stringify(EXEC_ADD_ITEM)}\n`, exitCode: 0 };
    }
    return { stdout: text, exitCode: 0 };
  };
  return session;
}

module.exports = {
  ROOT,
  WORKSPACE,
  FILES,
  PROMPT,
  DONE_TEXT,
  EXEC_ADD,
  EXEC_ADD_ITEM,
  scriptedLlm,
  writeTurns,
  writeThenExecTurns,
  attachMemoryExec,
};
