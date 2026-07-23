'use strict';

const fs = require('node:fs');

if (typeof process.getuid !== 'function' || process.getuid() !== 10001 || process.getgid() !== 10001) {
  console.error('sandbox worker must run as uid/gid 10001');
  process.exit(1);
}

try {
  fs.accessSync('/workspace', fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  fs.writeFileSync('/workspace/.sira-sandbox-ready', `${Date.now()}\n`, { mode: 0o600 });
} catch {
  console.error('sandbox workspace is not writable by the dedicated uid');
  process.exit(1);
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 60_000);
