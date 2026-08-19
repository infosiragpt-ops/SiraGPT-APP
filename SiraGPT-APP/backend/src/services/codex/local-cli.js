'use strict';

/**
 * JavaScript CLI entrypoints that must run with Node inside generated
 * workspaces. `bunx` invokes these packages with Bun, which is not reliable
 * under the runner's high, project-scoped Linux UIDs.
 */

const ENTRYPOINTS = Object.freeze({
  eslint: 'node_modules/eslint/bin/eslint.js',
  jest: 'node_modules/jest/bin/jest.js',
  tsc: 'node_modules/typescript/bin/tsc',
  vitest: 'node_modules/vitest/vitest.mjs',
});

function localCliCommand(name, ...args) {
  const entrypoint = ENTRYPOINTS[name];
  if (!entrypoint) throw new TypeError(`unsupported local CLI: ${name}`);
  return ['node', entrypoint, ...args];
}

module.exports = {
  ENTRYPOINTS,
  localCliCommand,
};
