// Typed command entry point required by specification §10.1. Generation only.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildFixtures } = require('./build-docs.cjs');
const output = process.argv[2];
if (!output) throw new Error('Usage: node --import tsx backend/tests/fixtures/build.ts ABSOLUTE_EMPTY_OUTPUT');
buildFixtures(output).then((manifest: { version: string; files: unknown[] }) => {
  console.log(JSON.stringify({ version: manifest.version, files: manifest.files.length, editorExecuted: false }));
}).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
