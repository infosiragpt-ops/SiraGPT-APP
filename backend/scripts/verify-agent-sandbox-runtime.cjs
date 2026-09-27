'use strict';

// Run inside the currently live backend container before activating a new
// document-runner image. This exercises the same sandbox route AgentRunner
// actually uses, including a remote service when configured. Print only a
// safe pass/fail marker; never log endpoint, credentials or session details.
const path = require('node:path');
const { createSandbox } = require(path.join(process.cwd(), 'src/services/doc-agent/sandbox'));

const source = [
  'import os, tempfile, pandas as pd, pyreadstat',
  'columns = [f"P{i:02d}" for i in range(1, 21)]',
  'frame = pd.DataFrame([[row * 100 + col for col in range(20)] for row in range(20)], columns=columns)',
  'with tempfile.NamedTemporaryFile(suffix=".sav", dir="/workspace", delete=False) as handle: path = handle.name',
  'try:',
  '    pyreadstat.write_sav(frame, path, column_labels={name: f"Pregunta {i}" for i, name in enumerate(columns, 1)})',
  '    restored, meta = pyreadstat.read_sav(path)',
  '    assert restored.shape == (20, 20)',
  '    assert restored.to_numpy().tolist() == frame.to_numpy().tolist()',
  '    assert sum(bool(label) for label in (meta.column_labels or [])) == 20',
  '    print("SPSS_RUNTIME_OK")',
  'finally:',
  '    os.unlink(path)',
].join('\n');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

(async () => {
  let sandbox;
  try {
    sandbox = await createSandbox();
    if (!['remote', 'docker'].includes(sandbox?.driver)) throw new Error('sandbox_not_isolated');
    const run = await sandbox.exec(`python3 -c ${shellQuote(source)}`, { timeoutMs: 30000 });
    if (run?.exitCode !== 0 || !String(run.stdout || '').trim().endsWith('SPSS_RUNTIME_OK')) {
      throw new Error('sandbox_spss_smoke_failed');
    }
    process.stdout.write(`AgentRunner sandbox SPSS smoke passed (${sandbox.driver}).\n`);
  } catch {
    process.stderr.write('AgentRunner sandbox SPSS smoke failed; deployment withheld.\n');
    process.exitCode = 1;
  } finally {
    try { await sandbox?.destroy(); } catch { process.exitCode = 1; }
  }
})();
