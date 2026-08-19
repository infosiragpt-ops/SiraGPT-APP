'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

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

  const result = Object.freeze({ loadedFiles });
  if (useCache) loaded = result;
  return result;
}

module.exports = {
  loadEnvFiles,
  ENV_CANDIDATES,
  BACKEND_DIR,
  ROOT_DIR,
};
