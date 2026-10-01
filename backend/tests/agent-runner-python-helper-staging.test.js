'use strict';

// Guard for the chart helpers used by execute_python («no podía graficar»):
// sira_charts.py / sira_office.py / sira_design.py are staged in
// /workspace/tmp and every Python call must be able to import them. The
// wiring lives in two files that are edited often; this test pins it without
// needing Python or a sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeToolExecutors } = require('../src/services/agent-runner/tools');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', relative), 'utf8');

test('agent-runner stages sira_charts.py next to the design and office helpers', () => {
  const index = read('index.js');
  assert.match(index, /sira_charts\.py/, 'index.js must read sira_charts.py');
  assert.match(index, /writeFile\('tmp\/sira_charts\.py'/, 'index.js must stage tmp/sira_charts.py in the workspace');
  assert.match(index, /writeFile\('tmp\/sira_design\.py'/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'sira_charts.py')));
  assert.match(read('sira_charts.py'), /def add_xlsx_chart\(/);
});

test('execute_python runs every script with /workspace/tmp importable', async () => {
  const commands = [];
  const sandbox = {
    exec: async (cmd) => { commands.push(cmd); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
  };
  const executors = makeToolExecutors(sandbox);
  const out = await executors.execute_python({ code: "from sira_charts import add_xlsx_chart\nprint('ok')" });
  assert.match(out, /ok/);
  assert.equal(commands.length, 1);
  const cmd = commands[0];
  assert.match(cmd, /sys\.path\.insert\(0, '\/workspace\/tmp'\)/, 'helpers in tmp/ must be importable');
  assert.match(cmd, /<<'PY'\nfrom sira_charts import add_xlsx_chart\nprint\('ok'\)\nPY/, 'the script travels unchanged in the heredoc');
  assert.match(cmd, /__file__.*<stdin>/, 'scripts keep stdin semantics');
});

test('the agent-runner prompt tells the model how to import the chart helper', () => {
  const prompt = read('prompt.js');
  assert.match(prompt, /from sira_charts import add_xlsx_chart/);
});
