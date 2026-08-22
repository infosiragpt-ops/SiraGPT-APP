'use strict';

/**
 * Disk artifact store for doc-engine jobs.
 * Binary buffers live on disk — never in Redis / BullMQ payloads.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function rootDir(env = process.env) {
  return String(env.DOC_ENGINE_ARTIFACT_DIR || path.join(os.tmpdir(), 'doc-engine-jobs')).trim();
}

function jobDir(jobId, env = process.env) {
  const id = String(jobId || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!id) throw new Error('artifact-store: jobId required');
  return path.join(rootDir(env), id);
}

function writeInputs(jobId, { sourceBuffer, templateBuffer } = {}, env = process.env) {
  const dir = jobDir(jobId, env);
  const input = path.join(dir, 'in');
  fs.mkdirSync(input, { recursive: true });
  const sourcePath = path.join(input, 'source.docx');
  const templatePath = path.join(input, 'template.docx');
  fs.writeFileSync(sourcePath, sourceBuffer);
  fs.writeFileSync(templatePath, templateBuffer);
  return { dir, input, sourcePath, templatePath, output: path.join(dir, 'out') };
}

function writeOutput(jobId, buffer, filename = 'output.docx', env = process.env) {
  const dir = path.join(jobDir(jobId, env), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function readInput(jobId, which = 'source', env = process.env) {
  const name = which === 'template' ? 'template.docx' : 'source.docx';
  return fs.readFileSync(path.join(jobDir(jobId, env), 'in', name));
}

function readOutput(jobId, filename = 'output.docx', env = process.env) {
  const outPath = path.join(jobDir(jobId, env), 'out', filename);
  if (!fs.existsSync(outPath)) return null;
  return fs.readFileSync(outPath);
}

function cleanup(jobId, env = process.env) {
  try {
    fs.rmSync(jobDir(jobId, env), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

module.exports = {
  rootDir,
  jobDir,
  writeInputs,
  writeOutput,
  readInput,
  readOutput,
  cleanup,
};
