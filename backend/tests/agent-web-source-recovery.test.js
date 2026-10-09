'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeToolExecutors } = require('../src/services/agent-runner/tools');

function setup(body, options = {}) {
  const files = new Map();
  const sandbox = {
    writeFile: async (name, content) => {
      if (options.writeFailure) throw new Error('private filesystem detail');
      files.set(name, content);
    },
    readFile: async (name) => Buffer.from(files.get(name)),
  };
  const executors = makeToolExecutors(sandbox, {
    web: { enabled: true,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async () => new Response(body, { status: options.status || 200,
        headers: { 'Content-Type': 'text/plain' } }),
    },
  });
  return { files, executors };
}

test('web source past the prompt limit remains recoverable through the existing read_file tool', async () => {
  const body = `${'Datos de referencia. '.repeat(4000)}RESULTADO_FINAL_731`;
  const { files, executors } = setup(body);
  const output = await executors.web_fetch({ url: 'https://example.com/report', max_chars: 500 });
  assert.equal(files.size, 1);
  const [filename, source] = [...files][0];
  assert.match(filename, /^tmp\/web-source-[a-f0-9]{24}\.txt$/);
  assert.ok(source.includes('RESULTADO_FINAL_731'));
  assert.match(source, /UNTRUSTED/);
  assert.ok(output.includes(filename));
  assert.ok(!output.includes('RESULTADO_FINAL_731'), 'summary stays bounded');
  const line = source.split('\n').findIndex(x => x.includes('RESULTADO_FINAL_731')) + 1;
  const recovered = await executors.read_file({ path: filename, offset: line, limit: 1 });
  assert.match(recovered, /RESULTADO_FINAL_731/);
  assert.match(output, /source_truncated.*false/);
});

test('sources use immutable content identities, preserving earlier retrievals', async () => {
  const first = setup('A'.repeat(1000));
  const second = setup('B'.repeat(1000));
  await first.executors.web_fetch({ url: 'https://example.com/report' });
  await second.executors.web_fetch({ url: 'https://example.com/report' });
  assert.notEqual([...first.files.keys()][0], [...second.files.keys()][0]);
});

test('a failed snapshot reports the limitation without claiming a saved path or leaking details', async () => {
  const { executors } = setup('Referencia fiable. '.repeat(100), { writeFailure: true });
  const output = await executors.web_fetch({ url: 'https://example.com/report' });
  assert.match(output, /source_save_failed/);
  assert.doesNotMatch(output, /source_path|private filesystem detail/);
  assert.match(output, /Referencia fiable/);
});

test('HTTP errors remain explicit and are not saved as research sources', async () => {
  const { files, executors } = setup('Forbidden', { status: 403 });
  const output = await executors.web_fetch({ url: 'https://example.com/report' });
  assert.match(output, /^ERROR:.*403/);
  assert.equal(files.size, 0);
});

test('a response exceeding the byte cap marks its saved source incomplete', async () => {
  const { files, executors } = setup('a'.repeat(2 * 1024 * 1024 + 500));
  const output = await executors.web_fetch({ url: 'https://example.com/large', max_chars: 500 });
  assert.match(output, /source_truncated.*true/);
  assert.ok([...files.values()][0].length < 2200000);
});
