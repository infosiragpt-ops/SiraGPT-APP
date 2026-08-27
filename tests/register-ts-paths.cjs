'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const COMPILED_ROOT = path.join(ROOT, '.test-dist');
const original = Module._resolveFilename;

Module._resolveFilename = function resolveAliased(request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    request = path.join(COMPILED_ROOT, request.slice(2));
  }
  return original.call(this, request, parent, isMain, options);
};
