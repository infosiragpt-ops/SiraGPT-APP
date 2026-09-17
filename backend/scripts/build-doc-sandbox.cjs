'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const backend = path.resolve(__dirname, '..');
const typeCheck = process.argv.includes('--check');
const tsc = require.resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', path.join(backend, 'tsconfig.doc-sandbox.json'), ...(typeCheck ? ['--noEmit'] : [])], { cwd: backend, stdio: 'inherit' });
if (result.error) { process.stderr.write('No se pudo ejecutar TypeScript.\n'); process.exit(1); }
if (result.status !== 0) process.exit(result.status || 1);
if (!typeCheck) {
  for (const relative of ['agent/prompts', 'validation/validator.py']) {
    const source = path.join(backend, 'src/modules/doc-sandbox', relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backend, 'dist/doc-sandbox', relative), { recursive: true });
  }
}
