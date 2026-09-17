'use strict';

/**
 * Durable SiraCode project files keyed by owner + chat.
 *
 * Survives session destroy / "re-login" without a new UI or AGENTES_CODING_V2.
 * Files stay jailed under SIRAGPT_SIRACODE_PROJECTS_DIR (tests inject a temp
 * root). Never writes outside that tree or into another user's folder.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { SKIP_DIRS, MAX_FILE_BYTES } = require('./workspace');

const MAX_FILES = 80;

function safeId(value, fallback = '') {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || fallback;
}

function persistRoot(env = process.env) {
  const override = String(env.SIRAGPT_SIRACODE_PROJECTS_DIR || '').trim();
  return override || path.join(os.tmpdir(), 'sira-code-projects');
}

function projectDir(userId, chatId, env = process.env) {
  const user = safeId(userId);
  const chat = safeId(chatId);
  if (!user || !chat) return null;
  return path.join(persistRoot(env), user, chat);
}

function assertInside(root, abs) {
  const base = path.resolve(root);
  const resolved = path.resolve(abs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    const err = new Error('ruta fuera del proyecto persistente');
    err.code = 'path_traversal';
    throw err;
  }
}

async function copyTree(src, dst, { skip, limit = { files: 0 } } = {}) {
  await fs.mkdir(dst, { recursive: true });
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  let copied = 0;
  for (const entry of entries) {
    if (limit.files >= MAX_FILES) break;
    if (!entry.name || entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && skip && skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    assertInside(dst, to);
    if (entry.isDirectory()) {
      copied += await copyTree(from, to, { skip, limit });
      continue;
    }
    if (!entry.isFile()) continue;
    let st;
    try {
      st = await fs.stat(from);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    await fs.copyFile(from, to);
    limit.files += 1;
    copied += 1;
  }
  return copied;
}

async function snapshot(workspace, userId, chatId, env = process.env) {
  const dest = projectDir(userId, chatId, env);
  if (!dest || !workspace || !workspace.root) return { ok: false, reason: 'missing_key' };
  await fs.mkdir(dest, { recursive: true });
  const copied = await copyTree(workspace.root, dest, { skip: SKIP_DIRS, limit: { files: 0 } });
  return { ok: true, files: copied, dir: dest };
}

async function restore(workspace, userId, chatId, env = process.env) {
  const src = projectDir(userId, chatId, env);
  if (!src || !workspace || !workspace.root) return { ok: false, reason: 'missing_key' };
  const copied = await copyTree(src, workspace.root, { skip: SKIP_DIRS, limit: { files: 0 } });
  return { ok: true, files: copied, dir: src };
}

module.exports = {
  safeId,
  persistRoot,
  projectDir,
  snapshot,
  restore,
};
