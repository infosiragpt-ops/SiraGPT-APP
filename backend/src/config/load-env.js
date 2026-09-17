'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { applyGitCommitFromDeployedTree } = require('../utils/deployed-tree-commit');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

const ENV_CANDIDATES = Object.freeze([
  path.join(BACKEND_DIR, '.env.local'),
  path.join(ROOT_DIR, '.env.local'),
  path.join(BACKEND_DIR, '.env'),
  path.join(ROOT_DIR, '.env'),
]);

let loaded = null;

function loadEnvFiles(options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : ENV_CANDIDATES;
  const useCache = !Array.isArray(options.candidates);
  if (useCache && loaded) return loaded;

  const loadedFiles = [];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
    loadedFiles.push(envPath);
  }

  // Default boot path only — isolated tests pass custom candidates and
  // must not rewrite the process GIT_COMMIT as a side effect.
  let gitCommit = null;
  if (useCache) {
    gitCommit = applyGitCommitFromDeployedTree();
  }

  const result = Object.freeze({ loadedFiles, gitCommit });
  if (useCache) loaded = result;
  return result;
}

module.exports = {
  loadEnvFiles,
  applyGitCommitFromDeployedTree,
  ENV_CANDIDATES,
  BACKEND_DIR,
  ROOT_DIR,
};
