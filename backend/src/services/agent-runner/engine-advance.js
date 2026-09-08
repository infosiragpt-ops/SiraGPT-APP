'use strict';

/**
 * 3H24 engine advance. Leftovers 3H23 skipped.
 * Ideas adapted, not copied: Letta/VoltAgent typed subagents; OpenClaw/Hermes SKILL.md
 * progressive disclosure of OUR files; gateway idempotency; sleep-time compact; Aider git-aware apply.
 * Original SiraGPT rewrite. No vendor source. No OpenRouter. DeepSeek Flash/Pro only.
 */

const crypto = require('crypto');
const path = require('path');

const SUBAGENT_TYPES = Object.freeze(['recall', 'implement', 'review']);
const SUBAGENT_BUDGETS = Object.freeze({ recall: 4, implement: 12, review: 6 });
const SUBAGENT_SLICE = Object.freeze({ recall: 0.25, implement: 0.6, review: 0.3 });
const WRITE_TOOLS = Object.freeze([
  'write_file', 'edit_file', 'apply_patch', 'str_replace',
  'create_presentation', 'set_slide_background', 'add_slide',
  'execute_bash', 'execute_python', 'bash',
]);
const SUBAGENT_ALLOWED = Object.freeze({
  recall: Object.freeze([
    'read_file', 'list_files', 'glob', 'grep', 'retrieve_memory',
    'load_skill', 'render_preview', 'web_search', 'web_fetch',
  ]),
  implement: Object.freeze([
    'read_file', 'list_files', 'glob', 'grep', 'retrieve_memory',
    'load_skill', 'write_file', 'edit_file', 'apply_patch', 'str_replace',
    'execute_bash', 'execute_python', 'bash',
    'create_presentation', 'set_slide_background', 'add_slide', 'render_preview',
  ]),
  review: Object.freeze([
    'read_file', 'list_files', 'glob', 'grep', 'retrieve_memory',
    'load_skill', 'render_preview', 'execute_python',
  ]),
});
const SIDE_EFFECT_METHODS = Object.freeze([
  'agent', 'agent.abort',
  'skills.delete', 'skills.persist',
  'memory.persist', 'memory.delete',
  'cron.create', 'cron.delete',
]);
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const SLEEP_COMPACT_THRESHOLD = 1800;
const SKILL_SUMMARY_CHARS = 280;
const GIT_APPLY_MAX_HUNKS = 32;

function resolveSubagentType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return { ok: true, type: null, skipped: true, code: null };
  if (!SUBAGENT_TYPES.includes(t)) {
    return { ok: false, type: null, code: 'subagent_type', error: 'tipo de subagente desconocido: ' + t };
  }
  return { ok: true, type: t, skipped: false, code: null };
}

function sliceSubagentBudget({ parentRemaining = 12, type = 'implement', requested = null } = {}) {
  const resolved = resolveSubagentType(type);
  if (!resolved.ok) return { ok: false, budget: 0, code: resolved.code, error: resolved.error };
  const kind = resolved.type || 'implement';
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const slice = SUBAGENT_SLICE[kind] || 0.5;
  const typed = SUBAGENT_BUDGETS[kind] || 8;
  let budget = Math.max(1, Math.min(typed, Math.floor(parent * slice) || typed));
  if (requested != null) {
    const r = Number(requested);
    if (Number.isFinite(r) && r > 0) budget = Math.min(budget, Math.floor(r));
  }
  if (parent <= 0) return { ok: false, budget: 0, type: kind, code: 'subagent_budget' };
  return { ok: true, budget, type: kind, parentRemaining: parent, code: null };
}

function assertSubagentToolAllowed(type, toolName) {
  const resolved = resolveSubagentType(type);
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };
  if (!resolved.type) return { ok: true, allowed: true, code: null };
  const name = String(toolName || '').trim();
  const allow = SUBAGENT_ALLOWED[resolved.type] || [];
  if (allow.includes(name)) return { ok: true, allowed: true, type: resolved.type, code: null };
  return {
    ok: false, allowed: false, type: resolved.type, tool: name,
    code: 'subagent_tool_denied',
    error: 'el subagente "' + resolved.type + '" no puede usar "' + name + '"',
  };
}

function createSubagentSpec({ type = 'implement', parentRemaining = 12, task = '', requested = null } = {}) {
  const resolved = resolveSubagentType(type);
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };
  const kind = resolved.type || 'implement';
  const sliced = sliceSubagentBudget({ parentRemaining, type: kind, requested });
  if (!sliced.ok) return sliced;
  return {
    ok: true, type: kind, budget: sliced.budget,
    allowedTools: (SUBAGENT_ALLOWED[kind] || []).slice(),
    writes: kind === 'implement',
    task: String(task || '').slice(0, 2000),
    code: null,
  };
}

function filterToolsForSubagent(tools, type) {
  const resolved = resolveSubagentType(type);
  if (!resolved.ok || !resolved.type) return { tools: Array.isArray(tools) ? tools : [], filtered: 0, code: null };
  const allow = new Set(SUBAGENT_ALLOWED[resolved.type] || []);
  const list = Array.isArray(tools) ? tools : [];
  const kept = list.filter((t) => allow.has(t && t.function && t.function.name ? String(t.function.name) : ''));
  return { tools: kept, filtered: list.length - kept.length, type: resolved.type, code: null };
}

function filterExecutorsForSubagent(executors, type) {
  const resolved = resolveSubagentType(type);
  const src = executors && typeof executors === 'object' ? executors : {};
  if (!resolved.ok || !resolved.type) return { executors: src, denied: [], code: null };
  const allow = new Set(SUBAGENT_ALLOWED[resolved.type] || []);
  const next = {};
  const denied = [];
  for (const [name, fn] of Object.entries(src)) {
    if (allow.has(name)) next[name] = fn;
    else denied.push(name);
  }
  return { executors: next, denied, type: resolved.type, code: denied.length ? 'subagent_tool_denied' : null };
}

function isWriteTool(name) {
  return WRITE_TOOLS.includes(String(name || ''));
}

function hashSkillBody(body) {
  return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex').slice(0, 16);
}

function catalogSkillsProgressive(list) {
  const src = Array.isArray(list) ? list : [];
  return src.map((s) => ({
    name: String(s && s.name || ''),
    description: String(s && s.description || '').slice(0, 160),
    hash: s && s.hash ? String(s.hash) : hashSkillBody(s && (s.body || s.description) || ''),
  })).filter((s) => s.name);
}

function discloseSkill(loaded, { level = 'body' } = {}) {
  if (!loaded || loaded.ok === false) {
    return { ok: false, code: 'skill_disclose', error: (loaded && loaded.error) || 'skill_missing' };
  }
  const lv = String(level || 'body').toLowerCase();
  const name = String(loaded.name || '');
  const description = String(loaded.description || '');
  const body = String(loaded.body || '');
  const hash = hashSkillBody(body || description);
  if (lv === 'summary') {
    return {
      ok: true, level: 'summary', name, description, hash, body: null,
      excerpt: body.slice(0, SKILL_SUMMARY_CHARS), code: null,
    };
  }
  if (lv === 'refs') {
    const refs = [];
    const re = /(?:^|\n)##?\s+([^\n]+)/g;
    let m;
    while ((m = re.exec(body))) refs.push(m[1].trim().slice(0, 80));
    return { ok: true, level: 'refs', name, description, hash, body: null, refs, code: null };
  }
  return { ok: true, level: 'body', name, description, hash, body, code: null };
}

function isSideEffectMethod(method) {
  return SIDE_EFFECT_METHODS.includes(String(method || ''));
}

function canonicalJson(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => k !== 'idempotencyKey').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function payloadHash(method, params) {
  const raw = String(method || '') + '|' + canonicalJson(params && typeof params === 'object' ? params : {});
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function createIdempotencyStore({ ttlMs = IDEMPOTENCY_TTL_MS, now = null } = {}) {
  const ttl = Math.max(1000, Number(ttlMs) || IDEMPOTENCY_TTL_MS);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const map = new Map();
  return {
    claim({ key, method, params, hash } = {}) {
      const id = String(key || '').trim();
      if (!id) return { ok: false, status: 'missing', code: 'idempotency_conflict', error: 'idempotencyKey vacio' };
      if (id.length > 256) return { ok: false, status: 'invalid', code: 'idempotency_conflict', error: 'idempotencyKey demasiado largo' };
      const h = hash || payloadHash(method, params);
      const t = clock();
      this.sweep(t);
      const rec = map.get(id);
      if (!rec) {
        map.set(id, { hash: h, method: String(method || ''), at: t, response: null, done: false });
        return { ok: true, status: 'first', hash: h, code: null };
      }
      if (rec.hash !== h) {
        return { ok: false, status: 'conflict', code: 'idempotency_conflict', error: 'la misma clave cubre otro payload' };
      }
      if (rec.done && rec.response != null) {
        return { ok: true, status: 'replay', response: rec.response, hash: h, code: 'idempotency_replay' };
      }
      return { ok: true, status: 'in_flight', hash: h, code: 'duplicate_turn' };
    },
    remember(key, response) {
      const rec = map.get(String(key || ''));
      if (!rec) return { ok: false, code: 'idempotency_conflict' };
      rec.response = response;
      rec.done = true;
      rec.at = clock();
      return { ok: true, code: 'idempotency_replay' };
    },
    sweep(nowTs) {
      const t = nowTs != null ? Number(nowTs) : clock();
      let dropped = 0;
      for (const [k, rec] of [...map.entries()]) {
        if ((t - Number(rec.at || 0)) >= ttl) {
          map.delete(k);
          dropped += 1;
        }
      }
      return { ok: true, dropped, remaining: map.size, code: dropped ? 'hash_sweep' : null };
    },
    size() { return map.size; },
  };
}

function estimateTokensLocal(text) {
  const s = text == null ? '' : String(text);
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
}

function extractFactAnchors(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const anchors = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    const content = String(m.content || '').trim();
    if (!content) continue;
    if (role === 'system' && /PIN:|CRITICAL|hecho critico/i.test(content)) {
      anchors.push({ kind: 'pin', text: content.slice(0, 400) });
      continue;
    }
    if (role === 'user') {
      const line = content.split('\n').find((l) => l.trim().length > 8) || content;
      anchors.push({ kind: 'user', text: line.slice(0, 280) });
    }
    if (role === 'assistant' && /decid[ii]|entregable|archivo|ruta:|path:/i.test(content)) {
      anchors.push({ kind: 'decision', text: content.slice(0, 280) });
    }
  }
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const k = a.kind + ':' + a.text;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= 12) break;
  }
  return out;
}

function sleepTimeCompact({
  messages, pins = [], persistMemory = null, userId = null, chatId = null,
  thresholdTokens = SLEEP_COMPACT_THRESHOLD, reason = null,
} = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const tokens = list.reduce((n, m) => n + estimateTokensLocal(m && m.content || ''), 0);
  const cap = Math.max(64, Number(thresholdTokens) || SLEEP_COMPACT_THRESHOLD);
  const anchors = extractFactAnchors(list);
  const pinList = Array.isArray(pins) ? pins.slice() : [];
  if (tokens < cap) {
    return {
      ok: true, compacted: false, skipped: true, tokens, threshold: cap,
      anchors, persisted: 0, pins: pinList.length, code: null, reason: reason || null,
    };
  }
  let compacted = list;
  let removed = 0;
  try {
    const parity = require('./engine-parity');
    const out = parity.compactByTokenBudget(list, { maxTokens: Math.max(400, Math.floor(cap * 0.6)) });
    compacted = out.messages || list;
    removed = out.removed || 0;
    if (pinList.length) {
      try {
        const rel = require('./engine-reliability');
        compacted = rel.pinCriticalFacts(compacted, pinList);
      } catch (_) { /* pins optional */ }
    }
  } catch (_) {
    compacted = list.slice(-8);
    removed = Math.max(0, list.length - compacted.length);
  }
  let persisted = 0;
  if (typeof persistMemory === 'function' && userId && anchors.length) {
    try {
      const payload = {
        userId, chatId,
        text: anchors.map((a) => '[' + a.kind + '] ' + a.text).join('\n'),
        source: 'sleep_compact',
        at: new Date().toISOString(),
      };
      const pr = persistMemory(payload);
      persisted = 1;
      if (pr && typeof pr.then === 'function') pr.catch(() => {});
    } catch (_) { persisted = 0; }
  }
  if (Array.isArray(messages)) {
    messages.splice(0, messages.length, ...compacted);
  }
  return {
    ok: true, compacted: true, skipped: false, tokens,
    afterTokens: compacted.reduce((n, m) => n + estimateTokensLocal(m && m.content || ''), 0),
    removed, anchors, persisted, pins: pinList.length,
    code: 'sleep_compact', reason: reason || 'sleep_compact',
  };
}

function jailPath(root, rel) {
  const base = path.resolve(String(root || '/workspace'));
  const target = path.resolve(base, String(rel || ''));
  const sep = path.sep;
  if (target !== base && !target.startsWith(base + sep)) {
    return { ok: false, code: 'path_traversal', path: null };
  }
  return { ok: true, path: target, rel: path.relative(base, target) || '.', code: null };
}

function parseUnifiedDiff(diff) {
  const raw = String(diff || '');
  if (!raw.trim()) return { ok: false, hunks: [], code: 'git_hunk_ambiguous', error: 'diff vacio' };
  if (raw.indexOf('\0') >= 0 || /^(GIT binary|Binary files)/m.test(raw)) {
    return { ok: false, hunks: [], code: 'git_binary_rejected', error: 'diff binario rechazado' };
  }
  const hunks = [];
  const lines = raw.split('\n');
  let current = null;
  for (const line of lines) {
    const hm = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hm) {
      if (current) hunks.push(current);
      current = { oldStart: Number(hm[1]), oldLines: [], newLines: [], raw: [line] };
      continue;
    }
    if (!current) continue;
    current.raw.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.newLines.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) current.oldLines.push(line.slice(1));
    else if (line.startsWith(' ') || line === '') {
      const body = line.startsWith(' ') ? line.slice(1) : line;
      current.oldLines.push(body);
      current.newLines.push(body);
    }
  }
  if (current) hunks.push(current);
  if (!hunks.length) return { ok: false, hunks: [], code: 'git_hunk_ambiguous', error: 'sin hunks' };
  if (hunks.length > GIT_APPLY_MAX_HUNKS) {
    return { ok: false, hunks: [], code: 'git_hunk_ambiguous', error: 'demasiados hunks' };
  }
  return { ok: true, hunks, code: null };
}

function applyHunksExact(before, hunks) {
  let text = String(before ?? '');
  const ordered = hunks.slice().reverse();
  for (const h of ordered) {
    const oldBlock = h.oldLines.join('\n');
    if (!oldBlock.length && h.newLines.length) {
      text = h.newLines.join('\n') + '\n' + text;
      continue;
    }
    const first = text.indexOf(oldBlock);
    if (first < 0) return { ok: false, code: 'git_hunk_ambiguous', error: 'hunk no coincide' };
    const second = text.indexOf(oldBlock, first + 1);
    if (second >= 0) return { ok: false, code: 'git_hunk_ambiguous', error: 'hunk no es unico' };
    text = text.slice(0, first) + h.newLines.join('\n') + text.slice(first + oldBlock.length);
  }
  return { ok: true, content: text, code: null };
}

function assertGitCleanForApply({ relPath, gitStatus = null } = {}) {
  if (typeof gitStatus !== 'function') {
    return { ok: true, skipped: true, code: null };
  }
  let status;
  try { status = gitStatus(relPath); } catch (err) {
    return { ok: false, code: 'git_apply_dirty', error: String(err && err.message || err) };
  }
  const raw = status && typeof status === 'object' ? status : { dirty: Boolean(status) };
  if (raw.symlink || raw.isSymlink) return { ok: false, code: 'symlink_rejected', error: 'no aplico diffs sobre symlink' };
  if (raw.binary) return { ok: false, code: 'git_binary_rejected', error: 'archivo binario' };
  if (raw.dirty || raw.unstaged || raw.uncommitted) {
    return { ok: false, code: 'git_apply_dirty', error: 'el archivo ' + relPath + ' tiene cambios sin commit' };
  }
  return { ok: true, skipped: false, code: null };
}

function applyExactDiff({
  root = '/workspace', relPath, diff, readFile, writeFile,
  gitStatus = null, syntaxValidate = null, isSymlink = null,
} = {}) {
  const jailed = jailPath(root, relPath);
  if (!jailed.ok) return { ok: false, code: jailed.code, error: 'ruta fuera del workspace' };
  if (typeof isSymlink === 'function') {
    try { if (isSymlink(jailed.path)) return { ok: false, code: 'symlink_rejected', error: 'symlink rechazado' }; } catch (_) {}
  }
  const clean = assertGitCleanForApply({ relPath: jailed.rel, gitStatus });
  if (!clean.ok) return clean;
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return parsed;
  let before = '';
  try { before = String(readFile(jailed.path) ?? ''); } catch (err) {
    return { ok: false, code: 'git_hunk_ambiguous', error: 'no pude leer: ' + (err && err.message) };
  }
  if (before.indexOf('\0') >= 0) return { ok: false, code: 'git_binary_rejected', error: 'archivo binario' };
  const applied = applyHunksExact(before, parsed.hunks);
  if (!applied.ok) return applied;
  const validate = typeof syntaxValidate === 'function' ? syntaxValidate : (() => {
    try { return require('./engine-reliability').syntaxValidate; } catch (_) {
      return () => ({ ok: true, kind: 'skip' });
    }
  })();
  try {
    const v = validate(jailed.rel || relPath, applied.content);
    if (v && v.ok === false) {
      return { ok: false, code: 'git_syntax_revert', error: v.error || 'syntax_invalid', reverted: true };
    }
  } catch (err) {
    return { ok: false, code: 'git_syntax_revert', error: String(err && err.message || err), reverted: true };
  }
  try { writeFile(jailed.path, applied.content); } catch (err) {
    return { ok: false, code: 'atomic_write', error: String(err && err.message || err) };
  }
  let after = applied.content;
  try { after = String(readFile(jailed.path) ?? ''); } catch (_) {}
  if (after !== applied.content) {
    try { writeFile(jailed.path, before); } catch (_) {}
    return { ok: false, code: 'write_hash', error: 'read-after-write mismatch', reverted: true };
  }
  return { ok: true, path: jailed.rel, hunks: parsed.hunks.length, bytes: Buffer.byteLength(applied.content), code: null };
}

function advanceSnapshot() {
  return {
    subagentTypes: true,
    subagentBudgetSlice: true,
    subagentToolAllow: true,
    skillProgressive: true,
    skillDiscloseLevels: true,
    firstPartyPlaybooks: true,
    protocolIdempotency: true,
    idempotencySweep: true,
    sleepTimeCompact: true,
    factAnchors: true,
    gitAwareApply: true,
    gitSyntaxRevert: true,
    types: SUBAGENT_TYPES.slice(),
    sideEffectMethods: SIDE_EFFECT_METHODS.slice(),
  };
}

module.exports = {
  SUBAGENT_TYPES, SUBAGENT_BUDGETS, SUBAGENT_ALLOWED, SIDE_EFFECT_METHODS,
  IDEMPOTENCY_TTL_MS, SLEEP_COMPACT_THRESHOLD,
  resolveSubagentType, sliceSubagentBudget, assertSubagentToolAllowed,
  createSubagentSpec, filterToolsForSubagent, filterExecutorsForSubagent, isWriteTool,
  hashSkillBody, catalogSkillsProgressive, discloseSkill,
  isSideEffectMethod, canonicalJson, payloadHash, createIdempotencyStore,
  extractFactAnchors, sleepTimeCompact,
  jailPath, parseUnifiedDiff, applyHunksExact, assertGitCleanForApply, applyExactDiff,
  advanceSnapshot,
};
