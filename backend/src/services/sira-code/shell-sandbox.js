'use strict';

/**
 * Sandboxed bash/shell contract for SiraCode.
 *
 * Inspired by OpenCode's shell tool shape (command + timeout + workspace
 * cwd; file edits belong on read/write/apply_patch) — native rewrite.
 * Zero literal copy of vendor/opencode. No tree-sitter, Effect, or PTY.
 *
 * Default: allowlisted read-ish commands only. Write-class commands are
 * for Construir (and permission-resume). Planificar never gets write or
 * network, even after an allow/always reply. Network stays off unless
 * the caller sets allowNetwork and the agent is construir.
 */

const path = require('path');
const { jailPath } = require('./workspace');

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 200;

const CLASS_RANK = Object.freeze({
  read: 0,
  write: 1,
  network: 2,
  dangerous: 3,
});

const READ_COMMANDS = new Set([
  'ls', 'pwd', 'echo', 'printf', 'cat', 'head', 'tail', 'wc',
  'file', 'stat', 'date', 'whoami', 'id', 'uname', 'basename',
  'dirname', 'true', 'false', 'test', '[', 'which', 'type',
  'diff', 'cmp', 'md5sum', 'sha256sum', 'sha1sum', 'sort',
  'uniq', 'cut', 'tr', 'nl', 'rev', 'fold', 'grep', 'egrep',
  'fgrep', 'find', 'tree', 'sleep', 'realpath',
]);

const WRITE_COMMANDS = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'tee', 'chmod', 'ln',
]);

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp',
  'ftp', 'telnet', 'nmap', 'ping', 'dig', 'nslookup', 'host',
  'traceroute', 'tracepath',
]);

const DANGEROUS_COMMANDS = new Set([
  'sudo', 'su', 'doas', 'eval', 'exec', 'source',
  'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish',
  'python', 'python2', 'python3', 'node', 'nodejs', 'perl', 'ruby',
  'php', 'lua', 'awk', 'dd', 'mkfs', 'mount', 'umount',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'kill', 'pkill', 'killall', 'chown', 'chgrp',
  'useradd', 'userdel', 'passwd', 'iptables', 'nft', 'sysctl',
  'docker', 'podman', 'kubectl', 'npm', 'npx', 'yarn', 'pnpm',
  'pip', 'pip3', 'apt', 'apt-get', 'apk', 'yum', 'dnf', 'brew',
  'nohup', 'tmux', 'screen', 'setuid',
]);

const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe',
  'ls-files', 'ls-tree', 'blame', 'shortlog',
]);
const GIT_WRITE = new Set([
  'add', 'commit', 'checkout', 'restore', 'reset', 'stash',
  'rebase', 'merge', 'tag', 'rm', 'mv', 'init', 'clean',
]);
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

const SAFE_VERSION_ARGS = new Set(['-v', '-V', '--version']);

const ERRORS = Object.freeze({
  validation: 'el comando es obligatorio',
  newline: 'el comando no puede incluir saltos de línea',
  command_substitution: 'la sustitución de comandos no está permitida',
  process_substitution: 'la sustitución de procesos no está permitida',
  expansion: 'la expansión de variables no está permitida',
  not_allowlisted: 'comando no está en la lista permitida',
  command_denied: 'comando no permitido',
  network_blocked: 'la red está bloqueada en el shell',
  plan_read_only: 'Planificar no puede escribir con el shell',
  path_escape: 'ruta fuera del workspace',
  timeout: 'el comando superó el tiempo límite',
});

function clampTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function basenameCmd(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const base = path.posix.basename(raw.replace(/\\/g, '/'));
  return base.toLowerCase();
}

function isFlag(token) {
  return String(token || '').startsWith('-');
}

function looksLikePath(token) {
  const raw = String(token || '');
  if (!raw || isFlag(raw)) return false;
  if (raw === '/' || raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return true;
  if (raw.includes('..')) return true;
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  return raw.includes('/') || raw.includes('\\');
}

function looksLikeUrl(token) {
  return /^(https?|ftp|ws|wss|git|ssh):\/\//i.test(String(token || ''))
    || /\/dev\/(tcp|udp)\b/i.test(String(token || ''));
}

function scanDeniedMeta(command) {
  const text = String(command || '');
  if (!text.trim()) return { code: 'validation', error: ERRORS.validation };
  if (/[\r\n]/.test(text)) return { code: 'newline', error: ERRORS.newline };
  if (/\$\(/.test(text) || /`/.test(text)) {
    return { code: 'command_substitution', error: ERRORS.command_substitution };
  }
  if (/<\(|>\(/.test(text)) {
    return { code: 'process_substitution', error: ERRORS.process_substitution };
  }
  if (/\/dev\/(tcp|udp)/i.test(text)) {
    return { code: 'network_blocked', error: ERRORS.network_blocked };
  }
  if (/\$(?![\?])[A-Za-z_{*]/.test(text)) {
    return { code: 'expansion', error: ERRORS.expansion };
  }
  return null;
}

function splitTopLevel(command) {
  const src = String(command || '');
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const push = (joiner) => {
    const trimmed = current.trim();
    if (trimmed) segments.push({ text: trimmed, joiner });
    current = '';
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' && src[i + 1] === '|') {
      push('||');
      i += 1;
      continue;
    }
    if (ch === '&' && src[i + 1] === '&') {
      push('&&');
      i += 1;
      continue;
    }
    if (ch === '|') {
      push('|');
      continue;
    }
    if (ch === ';' || ch === '&') {
      if (ch === '&') {
        return { error: { code: 'command_denied', error: `${ERRORS.command_denied}: segundo plano` } };
      }
      push(';');
      continue;
    }
    current += ch;
  }
  if (quote) {
    return { error: { code: 'validation', error: 'comillas sin cerrar' } };
  }
  push(null);
  return { segments };
}

function tokenize(segment) {
  const src = String(segment || '');
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const redirects = [];

  const flush = () => {
    if (current !== '') tokens.push(current);
    current = '';
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (quote === '\'') {
        current += ch;
      } else {
        escaped = true;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '>' || ch === '<') {
      flush();
      let op = ch;
      if (src[i + 1] === '>') {
        op += '>';
        i += 1;
      }
      let target = '';
      i += 1;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      const q = src[i] === '\'' || src[i] === '"' ? src[i] : null;
      if (q) {
        i += 1;
        while (i < src.length && src[i] !== q) {
          target += src[i];
          i += 1;
        }
      } else {
        while (i < src.length && !/\s/.test(src[i]) && src[i] !== '|' && src[i] !== '&' && src[i] !== ';') {
          target += src[i];
          i += 1;
        }
        i -= 1;
      }
      redirects.push({ op, target: target.trim() });
      continue;
    }
    current += ch;
  }
  flush();
  return { tokens, redirects };
}

function jailArg(workspaceRoot, token) {
  const raw = String(token || '').trim();
  if (!raw) return;
  if (raw === '-' || raw === '/dev/null' || raw === '/dev/stdin' || raw === '/dev/stdout' || raw === '/dev/stderr') {
    return;
  }
  if (raw.startsWith('~')) {
    const err = new Error(ERRORS.path_escape);
    err.code = 'path_escape';
    throw err;
  }
  if (raw.includes('\0') || raw.includes('..')) {
    const err = new Error(ERRORS.path_escape);
    err.code = 'path_escape';
    throw err;
  }
  if (!looksLikePath(raw)) return;
  try {
    jailPath(workspaceRoot, raw);
  } catch (err) {
    const wrap = new Error(ERRORS.path_escape);
    wrap.code = 'path_escape';
    wrap.cause = err;
    throw wrap;
  }
}

function classifySpecial(cmd, args) {
  if (cmd === 'git') {
    const sub = String(args[0] || '').replace(/^-/, '');
    if (!sub || isFlag(args[0])) return { className: 'read', cmd: 'git' };
    if (GIT_NETWORK.has(sub)) return { className: 'network', cmd: 'git' };
    if (GIT_WRITE.has(sub)) return { className: 'write', cmd: 'git' };
    if (GIT_READ.has(sub)) return { className: 'read', cmd: 'git' };
    if (sub === 'branch') {
      const destructive = args.some((a) => /^-([Ddm]|-delete|-move)/.test(a));
      return { className: destructive ? 'write' : 'read', cmd: 'git' };
    }
    if (sub === 'config') {
      const readOnly = args.some((a) => a === '--get' || a === '--list' || a === '-l');
      return { className: readOnly ? 'read' : 'write', cmd: 'git' };
    }
    return { className: 'dangerous', cmd: 'git' };
  }
  if (cmd === 'node' || cmd === 'nodejs' || cmd === 'python' || cmd === 'python3' || cmd === 'python2') {
    if (args.length === 1 && SAFE_VERSION_ARGS.has(args[0])) {
      return { className: 'read', cmd };
    }
    return { className: 'dangerous', cmd };
  }
  if (cmd === 'npm' || cmd === 'npx' || cmd === 'yarn' || cmd === 'pnpm') {
    if (args.length === 1 && SAFE_VERSION_ARGS.has(args[0])) {
      return { className: 'read', cmd };
    }
    return { className: 'network', cmd };
  }
  if (cmd === 'find') {
    if (args.some((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-delete')) {
      return { className: 'dangerous', cmd };
    }
    return { className: 'read', cmd };
  }
  if (cmd === 'sed') {
    if (args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')) {
      return { className: 'write', cmd };
    }
    if (args.some((a) => a === 'e' || a === '-e' || /(^|[;'"])e/.test(a))) {
      // keep sed -e 's/a/b/' as read; deny the exec flag `e` as a standalone script letter
    }
    if (args.some((a) => /(^|;)e\b/.test(a) && !/^s([^\w])/.test(a))) {
      return { className: 'dangerous', cmd };
    }
    return { className: 'read', cmd };
  }
  if (cmd === 'chmod') {
    if (args.some((a) => /[sStT]|\+s|777|a\+rwx/.test(a))) {
      return { className: 'dangerous', cmd };
    }
    return { className: 'write', cmd };
  }
  return null;
}

function classifySegment(text, workspaceRoot) {
  const { tokens, redirects } = tokenize(text);
  if (!tokens.length && !redirects.length) {
    return { className: 'read', cmd: '' };
  }
  const rawCmd = tokens[0] || '';
  const cmd = basenameCmd(rawCmd);
  const args = tokens.slice(1);

  if (rawCmd.includes('/') && cmd && workspaceRoot) {
    try {
      jailArg(workspaceRoot, rawCmd);
    } catch (err) {
      return { className: 'dangerous', cmd, error: err };
    }
  }

  let className = 'read';
  const special = classifySpecial(cmd, args);
  if (special) {
    className = special.className;
  } else if (READ_COMMANDS.has(cmd)) {
    className = 'read';
  } else if (WRITE_COMMANDS.has(cmd)) {
    className = 'write';
  } else if (NETWORK_COMMANDS.has(cmd)) {
    className = 'network';
  } else if (DANGEROUS_COMMANDS.has(cmd)) {
    className = 'dangerous';
  } else if (!cmd) {
    className = 'read';
  } else {
    return {
      className: 'dangerous',
      cmd,
      code: 'not_allowlisted',
      error: `${ERRORS.not_allowlisted}: ${cmd}`,
    };
  }

  if (redirects.some((row) => row.op === '>' || row.op === '>>')) {
    if (CLASS_RANK[className] < CLASS_RANK.write) className = 'write';
  }

  if (workspaceRoot) {
    try {
      for (const arg of args) {
        if (looksLikeUrl(arg)) {
          if (CLASS_RANK[className] < CLASS_RANK.network) className = 'network';
          continue;
        }
        jailArg(workspaceRoot, arg);
      }
      for (const row of redirects) {
        if (row.target) jailArg(workspaceRoot, row.target);
      }
    } catch (err) {
      return { className: 'dangerous', cmd, code: err.code || 'path_escape', error: err.message };
    }
  }

  return { className, cmd, args, redirects };
}

function maxClass(a, b) {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

function classifyCommand(command, opts = {}) {
  const meta = scanDeniedMeta(command);
  if (meta) {
    return {
      ok: false,
      code: meta.code,
      error: meta.error,
      className: meta.code === 'network_blocked' ? 'network' : 'dangerous',
    };
  }

  const split = splitTopLevel(command);
  if (split.error) {
    return { ok: false, ...split.error, className: 'dangerous' };
  }

  let className = 'read';
  const parts = [];
  for (const segment of split.segments) {
    const classified = classifySegment(segment.text, opts.workspaceRoot);
    if (classified.error && classified.code) {
      return {
        ok: false,
        code: classified.code,
        error: classified.error,
        className: classified.className,
        cmd: classified.cmd,
      };
    }
    if (classified.error && classified.error.code) {
      return {
        ok: false,
        code: classified.error.code,
        error: classified.error.message,
        className: 'dangerous',
        cmd: classified.cmd,
      };
    }
    className = maxClass(className, classified.className);
    parts.push(classified);
  }

  return {
    ok: true,
    className,
    parts,
    command: String(command || '').trim(),
  };
}

function authorizeShellCommand(command, opts = {}) {
  const agentId = String(opts.agentId || 'construir');
  const allowNetwork = truthy(opts.allowNetwork);
  const classified = classifyCommand(command, opts);
  if (!classified.ok) return classified;

  if (classified.className === 'dangerous') {
    const cmd = classified.parts && classified.parts[0] && classified.parts[0].cmd;
    return {
      ok: false,
      code: classified.code || 'command_denied',
      error: classified.error || `${ERRORS.command_denied}${cmd ? `: ${cmd}` : ''}`,
      className: 'dangerous',
    };
  }

  if (classified.className === 'network') {
    if (!allowNetwork || agentId !== 'construir') {
      return {
        ok: false,
        code: 'network_blocked',
        error: ERRORS.network_blocked,
        className: 'network',
      };
    }
  }

  if (classified.className === 'write' && agentId !== 'construir') {
    return {
      ok: false,
      code: 'plan_read_only',
      error: ERRORS.plan_read_only,
      className: 'write',
    };
  }

  return {
    ok: true,
    className: classified.className,
    parts: classified.parts,
    command: classified.command,
    timeoutMs: clampTimeoutMs(opts.timeoutMs),
    allowNetwork: allowNetwork && agentId === 'construir' && classified.className === 'network',
  };
}

module.exports = {
  READ_COMMANDS,
  WRITE_COMMANDS,
  NETWORK_COMMANDS,
  DANGEROUS_COMMANDS,
  ERRORS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  clampTimeoutMs,
  classifyCommand,
  authorizeShellCommand,
  jailArg,
  basenameCmd,
};
