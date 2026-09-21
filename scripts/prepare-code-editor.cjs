// Serve the pinned Monaco runtime from our own origin in dev and production.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// Resolve the supported CommonJS entry (min/vs/index.js). Monaco's exports
// map does not expose package.json; resolving that subpath fails in clean CI.
const runtime = path.resolve(path.dirname(require.resolve('monaco-editor')), '..', '..');
const target = path.join(root, 'public', 'code-editor', 'vs');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(runtime, 'min', 'vs'), target, { recursive: true });
console.log('Code editor runtime prepared');
