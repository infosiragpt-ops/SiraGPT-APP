'use strict';

/**
 * git.service — host-level git operations via `simple-git`.
 *
 * Step 4 surface: clone. Later steps (status/pull/push/branches/diff) extend
 * this same module so all git access funnels through one hardened wrapper.
 *
 * Security model:
 *   - Private repos clone over HTTPS with the user's OAuth token injected as
 *     `x-access-token:<token>@…`. Immediately after a successful clone the
 *     remote is rewritten back to the clean URL so the token NEVER persists
 *     in `.git/config`. It is re-injected per-operation when push/pull need it.
 *   - `GIT_TERMINAL_PROMPT=0` + empty `credential.helper` so git can never
 *     block on an interactive auth prompt or read the host credential store.
 *   - Any token that leaks into an error string is scrubbed before it is
 *     thrown/logged.
 *   - The destination path is validated by WorkspaceManager (allowed root +
 *     not the product source) before we get here.
 */

const path = require('path');
let simpleGit;
try {
  simpleGit = require('simple-git');
} catch {
  simpleGit = null;
}

const { ensureParentDir, isGitRepo, ensureLocalExcludes } = require('./workspace-manager');

const CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — large repos
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

function gitError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Validate a branch name; returns the name, '' for none, or null if invalid. */
function safeBranchName(raw) {
  const branch = String(raw || '').trim();
  if (!branch) return '';
  if (!SAFE_BRANCH_RE.test(branch)) return null;
  if (branch.includes('..') || branch.includes('@{') || branch.includes('//')) return null;
  if (branch.endsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')) return null;
  return branch;
}

/** Inject an OAuth token into an https GitHub clone URL (no-op for non-https). */
function authenticatedUrl(cloneUrl, token) {
  if (!token) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    if (u.protocol !== 'https:') return cloneUrl;
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return cloneUrl;
  }
}

/** Strip any occurrence of the token (and basic-auth creds) from a string. */
function scrubToken(message, token) {
  let out = String(message || '');
  if (token) out = out.split(token).join('***');
  out = out.replace(/(https?:\/\/)[^@/\s]+:[^@/\s]+@/gi, '$1***@');
  return out;
}

/** A simple-git instance hardened against prompts + host credential store. */
function hardenedGit(baseDir) {
  return simpleGit({
    baseDir,
    timeout: { block: CLONE_TIMEOUT_MS },
    // Set credential.helper to EMPTY so git never reads the host credential
    // store or blocks on a prompt. simple-git v3 guards `credential.helper`
    // as "unsafe" by default; we're disabling it (the safe direction), so we
    // opt in explicitly to satisfy the guard.
    config: ['credential.helper='],
    unsafe: {
      allowUnsafeCredentialHelper: true,
      allowUnsafeEditor: true,
      allowUnsafeAskPass: true,
      // allowUnsafeShell: true,
      // allowUnsafePath: true,
      // allowUnsafeProtocol: true,
      // allowUnsafeHttp: true,
      // allowUnsafeHttps: true,
      // allowUnsafeGit: true,
      // allowUnsafeGitConfig: true,
      // allowUnsafeGitConfigLocal: true,
    }
  }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
}

/**
 * Clone a repository into an already-validated absolute localPath.
 *
 * @param {object} args
 * @param {string} args.localPath  validated destination (WorkspaceManager)
 * @param {string} args.cloneUrl   clean https clone url (no token)
 * @param {string} [args.token]    OAuth access token (required for private)
 * @param {string} [args.branch]   branch to check out
 * @returns {Promise<{alreadyCloned:boolean, localPath:string, branch:string|null}>}
 */
async function cloneRepository({ localPath, cloneUrl, token, branch }) {
  const branchName = safeBranchName(branch);
  if (branchName === null) {
    throw gitError(400, 'invalid_branch', 'Invalid branch name');
  }

  if (isGitRepo(localPath)) {
    ensureLocalExcludes(localPath);
    let current = branchName || null;
    try {
      current = (await simpleGit(localPath).status()).current || current;
    } catch {
      /* best-effort */
    }
    return { alreadyCloned: true, localPath, branch: current };
  }

  ensureParentDir(localPath);
  const git = hardenedGit(path.dirname(localPath));
  const url = authenticatedUrl(cloneUrl, token);
  const options = branchName ? ['--branch', branchName] : [];

  try {
    await git.clone(url, localPath, options);
  } catch (err) {
    throw gitError(502, 'clone_failed', `Clone failed: ${scrubToken(err.message, token).slice(0, 500)}`);
  }

  // Never leave the token sitting in .git/config — reset to the clean URL.
  try {
    await simpleGit(localPath).remote(['set-url', 'origin', cloneUrl]);
  } catch {
    /* non-fatal: the clone itself succeeded */
  }

  // Keep build artifacts (node_modules/, dist/, …) out of `git status`.
  ensureLocalExcludes(localPath);

  let currentBranch = branchName || null;
  try {
    currentBranch = (await simpleGit(localPath).status()).current || currentBranch;
  } catch {
    /* best-effort */
  }

  return { alreadyCloned: false, localPath, branch: currentBranch };
}

// ──────────────────────────────────────────────────────────────
// Step 5 — status / changes / diff / pull / fetch / add / commit /
// push / branches / history. All operate on an already-validated
// localPath (the route layer resolves + checks it first).
// ──────────────────────────────────────────────────────────────

/** Reject paths that could escape the repo or smuggle a CLI flag. */
function isSafeRelPath(p) {
  const v = String(p || '');
  if (!v || v.startsWith('-')) return false;
  if (v.includes('..') || v.includes('\0')) return false;
  if (path.isAbsolute(v)) return false;
  return true;
}

function mapStatus(s) {
  return {
    current: s.current,
    tracking: s.tracking,
    ahead: s.ahead,
    behind: s.behind,
    detached: s.detached,
    clean: typeof s.isClean === 'function' ? s.isClean() : s.files.length === 0,
    staged: s.staged,
    files: s.files.map((f) => ({ path: f.path, index: f.index, workingDir: f.working_dir })),
  };
}

/** Changed-files view: new vs modified vs deleted (file-tracking requirement). */
function summarizeChanges(s) {
  return {
    new: Array.from(new Set([...(s.not_added || []), ...(s.created || [])])),
    modified: s.modified || [],
    deleted: s.deleted || [],
    renamed: s.renamed || [],
    conflicted: s.conflicted || [],
    staged: s.staged || [],
    total: s.files.length,
  };
}

async function getStatus(localPath) {
  return mapStatus(await simpleGit(localPath).status());
}

async function getChanges(localPath) {
  return summarizeChanges(await simpleGit(localPath).status());
}

async function getDiff(localPath, { file, staged } = {}) {
  const git = simpleGit(localPath);
  const args = [];
  if (staged) args.push('--staged');
  if (file) {
    if (!isSafeRelPath(file)) throw gitError(400, 'invalid_path', 'Invalid file path');
    args.push('--', file);
  }
  const patch = await git.diff(args);
  const summary = await git.diffSummary(staged ? ['--staged'] : []);
  return { patch, summary };
}

async function stageFiles(localPath, files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw gitError(400, 'no_files', 'files[] is required');
  }
  const git = simpleGit(localPath);
  // Special "stage everything" tokens.
  if (files.length === 1 && ['.', '-A', 'all', '*'].includes(files[0])) {
    await git.add('.');
    return { staged: 'all' };
  }
  for (const f of files) {
    if (!isSafeRelPath(f)) throw gitError(400, 'invalid_path', `Invalid file path: ${f}`);
  }
  await git.add(files);
  return { staged: files };
}

async function commit(localPath, { message, authorName, authorEmail } = {}) {
  const msg = String(message || '').trim();
  if (!msg) throw gitError(400, 'empty_message', 'Commit message is required');
  const git = simpleGit(localPath);
  // Set a local identity so commit never fails on a fresh box with no global
  // git config. Scope 'local' keeps it inside this repo only.
  if (authorName) await git.addConfig('user.name', authorName, false, 'local');
  if (authorEmail) await git.addConfig('user.email', authorEmail, false, 'local');
  try {
    const res = await git.commit(msg);
    return { commit: res.commit, branch: res.branch, summary: res.summary };
  } catch (err) {
    throw gitError(400, 'commit_failed', String(err.message || 'commit failed').slice(0, 400));
  }
}

async function pull(localPath, { remoteUrl, token, branch } = {}) {
  const git = hardenedGit(localPath);
  const url = authenticatedUrl(remoteUrl, token);
  const branchName = safeBranchName(branch);
  if (branchName === null) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  try {
    const res = branchName ? await git.pull(url, branchName) : await git.pull(url);
    // Keep the tracking ref in step so "behind" clears after a pull.
    await syncTrackingRef(git, branchName);
    return {
      summary: res.summary,
      files: res.files,
      insertions: res.insertions,
      deletions: res.deletions,
    };
  } catch (err) {
    throw gitError(502, 'pull_failed', scrubToken(err.message, token).slice(0, 400));
  }
}

async function fetch(localPath, { remoteUrl, token, branch } = {}) {
  const git = hardenedGit(localPath);
  const url = authenticatedUrl(remoteUrl, token);
  const branchName = safeBranchName(branch);
  if (branchName === null) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  try {
    // Fetch with an explicit refspec so the LOCAL remote-tracking refs
    // (refs/remotes/origin/*) actually move. A bare `git fetch <url>` only
    // writes FETCH_HEAD, which leaves `git status` ahead/behind stale.
    const refspec = branchName
      ? `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`
      : '+refs/heads/*:refs/remotes/origin/*';
    const res = await git.fetch(url, refspec);
    return { raw: res };
  } catch (err) {
    throw gitError(502, 'fetch_failed', scrubToken(err.message, token).slice(0, 400));
  }
}

/**
 * After a push/pull over a URL remote, git does NOT advance the local
 * remote-tracking ref (refs/remotes/origin/<branch>), so `git status` keeps
 * reporting the synced commits as "ahead/behind". Move it to the given branch's
 * current commit so the ahead/behind counters settle to 0.
 */
async function syncTrackingRef(git, branchName) {
  try {
    const target = branchName || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (!target || target === 'HEAD') return;
    const sha = (await git.revparse([target])).trim();
    if (sha) await git.raw(['update-ref', `refs/remotes/origin/${target}`, sha]);
  } catch {
    /* non-fatal — counters will correct on the next fetch */
  }
}

async function push(localPath, { remoteUrl, token, branch, setUpstream } = {}) {
  const git = hardenedGit(localPath);
  const url = authenticatedUrl(remoteUrl, token);
  const branchName = safeBranchName(branch);
  if (branchName === null) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  const options = {};
  if (setUpstream && branchName) options['--set-upstream'] = null;
  try {
    const res = branchName ? await git.push(url, branchName, options) : await git.push(url);
    // Advance the local tracking ref so `git status` no longer shows the
    // just-pushed commits as "ahead".
    await syncTrackingRef(git, branchName);
    return { pushed: res.pushed, update: res.update, branch: branchName || null };
  } catch (err) {
    throw gitError(502, 'push_failed', scrubToken(err.message, token).slice(0, 400));
  }
}

/**
 * Discard working-tree changes (Replit's "Discard All"). With no files (or the
 * "." token) it restores ALL tracked modifications. Untracked files are left
 * alone so nothing the user just created is silently deleted.
 */
async function discardChanges(localPath, files) {
  const git = simpleGit(localPath);
  const all = !Array.isArray(files) || files.length === 0 || (files.length === 1 && ['.', '-A', 'all', '*'].includes(files[0]));
  if (all) {
    await git.checkout(['--', '.']);
    return { discarded: 'all' };
  }
  for (const f of files) {
    if (!isSafeRelPath(f)) throw gitError(400, 'invalid_path', `Invalid file path: ${f}`);
  }
  await git.checkout(['--', ...files]);
  return { discarded: files };
}

async function listBranches(localPath) {
  const git = simpleGit(localPath);
  const local = await git.branchLocal();
  let remote = [];
  try {
    remote = (await git.branch(['-r'])).all;
  } catch {
    /* no remotes yet */
  }
  return { current: local.current, local: local.all, remote };
}

async function createBranch(localPath, name, { checkout = true } = {}) {
  const b = safeBranchName(name);
  if (!b) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  const git = simpleGit(localPath);
  if (checkout) await git.checkoutLocalBranch(b);
  else await git.branch([b]);
  return { created: b, checkedOut: Boolean(checkout) };
}

async function switchBranch(localPath, name) {
  const b = safeBranchName(name);
  if (!b) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  await simpleGit(localPath).checkout(b);
  return { current: b };
}

async function deleteBranch(localPath, name, { force = false } = {}) {
  const b = safeBranchName(name);
  if (!b) throw gitError(400, 'invalid_branch', 'Invalid branch name');
  const res = await simpleGit(localPath).deleteLocalBranch(b, Boolean(force));
  return { deleted: b, success: res.success };
}

async function commitHistory(localPath, { limit = 30, branch } = {}) {
  const max = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 30));
  const args = [`--max-count=${max}`];
  if (branch) {
    const b = safeBranchName(branch);
    if (!b) throw gitError(400, 'invalid_branch', 'Invalid branch name');
    args.push(b);
  }
  const log = await simpleGit(localPath).log(args);
  return log.all.map((c) => ({
    hash: c.hash,
    date: c.date,
    message: c.message,
    authorName: c.author_name,
    authorEmail: c.author_email,
    refs: c.refs,
  }));
}

module.exports = {
  cloneRepository,
  authenticatedUrl,
  safeBranchName,
  scrubToken,
  hardenedGit,
  // Step 5
  getStatus,
  getChanges,
  getDiff,
  stageFiles,
  discardChanges,
  commit,
  pull,
  fetch,
  push,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  commitHistory,
  isSafeRelPath,
};
