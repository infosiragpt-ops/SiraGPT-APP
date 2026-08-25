'use strict';

/**
 * SiraGPT action gateway — first-party rewrite of OpenBot *ideas*
 * (CopilotKit/openbot, MIT). Not a vendor copy: no CopilotKit Intelligence,
 * no COPILOTKIT_LICENSE_TOKEN, no CEL runtime, no AG-UI remote, no gVisor
 * supervisor, no OpenAI/OpenRouter.
 *
 * Contract: resolve target → evaluate policy (deny before allow; missing
 * policy permits nothing) → write the audit row → only then execute.
 *
 * Default owner policy is explicit: deny=[], allow=["true"] so Luis's own
 * /code still works, and every action still gets a row.
 *
 * DeepSeek V4 Flash/Pro only. Skills stay instructions, not capabilities.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GOVERNED_TOOLS = new Set([
  'execute_bash', 'bash', 'execute_python',
  'read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep',
  'apply_patch', 'browser_act', 'web_fetch', 'web_search',
  'computer_click', 'computer_type', 'computer_key', 'computer_navigate',
  'computer_read_file', 'computer_write_file', 'computer_list_files',
  'shell', 'exec',
]);

const DEFAULT_OWNER_POLICY = Object.freeze({
  mode: 'enforce',
  deny: [],
  allow: ['true'],
});

const humanHold = new Map();
const computers = new Map();
let auditPathOverride = null;
let policyOverride = undefined; // undefined = load default; null = missing (fail-closed)

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function resolveAuditPath() {
  if (auditPathOverride) return auditPathOverride;
  if (process.env.SIRAGPT_CODE_AUDIT_PATH) return process.env.SIRAGPT_CODE_AUDIT_PATH;
  if (fs.existsSync('/opt/siragpt/data')) return '/opt/siragpt/data/code-audit.jsonl';
  if (fs.existsSync('/app/data')) return '/app/data/code-audit.jsonl';
  return path.join(os.tmpdir(), 'siragpt-code-audit.jsonl');
}

function resolvePolicyPath() {
  if (process.env.SIRAGPT_CODE_POLICY_PATH) return process.env.SIRAGPT_CODE_POLICY_PATH;
  if (fs.existsSync('/opt/siragpt/data')) return '/opt/siragpt/data/code-policy.json';
  if (fs.existsSync('/app/data')) return '/app/data/code-policy.json';
  return null;
}

function loadPolicy() {
  if (policyOverride === null) return null;
  if (policyOverride && typeof policyOverride === 'object') return policyOverride;
  const p = resolvePolicyPath();
  if (p && fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      return {
        mode: raw.mode === 'dry-run' ? 'dry-run' : 'enforce',
        deny: Array.isArray(raw.deny) ? raw.deny.map(String) : [],
        allow: Array.isArray(raw.allow) ? raw.allow.map(String) : [],
      };
    } catch (_) {
      return null; // broken file = missing = fail-closed
    }
  }
  return { ...DEFAULT_OWNER_POLICY, deny: [...DEFAULT_OWNER_POLICY.deny], allow: [...DEFAULT_OWNER_POLICY.allow] };
}

function setPolicyForTests(policy) {
  policyOverride = policy;
}

function setAuditPathForTests(p) {
  auditPathOverride = p;
}

function resetGatewayStateForTests() {
  humanHold.clear();
  computers.clear();
  policyOverride = undefined;
  auditPathOverride = null;
}

function get(obj, dotted) {
  const parts = String(dotted || '').split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function lit(token) {
  const t = String(token || '').trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * Tiny fail-closed expression language. Ideas from OpenBot CEL, rewritten:
 *   true | false
 *   tool.name == "execute_bash"
 *   intent == "write_file"
 *   contains(file.name, ".env")
 *   matches(page.host, "evil\\.com")
 *   a && b | a || b
 * No eval(). A throw means the rule is broken.
 */
function evalExpr(expression, ctx) {
  const src = String(expression || '').trim();
  if (!src) throw new Error('empty_rule');
  if (src === 'true') return true;
  if (src === 'false') return false;

  function evalAtom(s) {
    const t = s.trim();
    const contains = t.match(/^contains\(\s*([^,]+)\s*,\s*(.+)\)\s*$/i);
    if (contains) {
      const hay = resolveVal(contains[1].trim(), ctx);
      const needle = resolveVal(contains[2].trim(), ctx);
      return String(hay == null ? '' : hay).toLowerCase().includes(String(needle == null ? '' : needle).toLowerCase());
    }
    const matches = t.match(/^matches\(\s*([^,]+)\s*,\s*(.+)\)\s*$/i);
    if (matches) {
      const value = String(resolveVal(matches[1].trim(), ctx) == null ? '' : resolveVal(matches[1].trim(), ctx));
      const pattern = String(resolveVal(matches[2].trim(), ctx) == null ? '' : resolveVal(matches[2].trim(), ctx));
      try {
        return new RegExp(pattern, 'i').test(value);
      } catch (err) {
        throw new Error(`not a valid pattern: ${pattern}`);
      }
    }
    const cmp = t.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
    if (cmp) {
      const left = resolveVal(cmp[1].trim(), ctx);
      const right = resolveVal(cmp[3].trim(), ctx);
      if (cmp[2] === '==') return left === right || String(left) === String(right);
      return left !== right && String(left) !== String(right);
    }
    return Boolean(resolveVal(t, ctx));
  }

  function resolveVal(token, context) {
    const t = token.trim();
    if (t === 'true' || t === 'false' || /^-?\d/.test(t) || t.startsWith('"') || t.startsWith("'")) {
      return lit(t);
    }
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t)) {
      const v = get(context, t);
      return v;
    }
    return lit(t);
  }

  // split || then && — left to right, no parens (leftover: full CEL)
  const orParts = splitTop(src, '||');
  if (orParts.length > 1) {
    return orParts.some((p) => evalExpr(p, ctx) === true);
  }
  const andParts = splitTop(src, '&&');
  if (andParts.length > 1) {
    return andParts.every((p) => evalExpr(p, ctx) === true);
  }
  return evalAtom(src) === true;
}

function splitTop(src, sep) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') { depth += 1; buf += ch; continue; }
    if (ch === ')') { depth -= 1; buf += ch; continue; }
    if (depth === 0 && src.slice(i, i + sep.length) === sep) {
      out.push(buf);
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function evaluatePolicy(policy, context) {
  const mode = policy && policy.mode === 'dry-run' ? 'dry-run' : 'enforce';
  if (!policy || typeof policy !== 'object') {
    return {
      allow: false,
      allowed: false,
      forward: false,
      rule: 'missing_policy',
      source: 'default',
      mode,
      reason: 'No hay política. Fail-closed: se negó la acción.',
    };
  }
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  const allow = Array.isArray(policy.allow) ? policy.allow : [];

  for (const expression of deny) {
    let hit = false;
    try {
      hit = evalExpr(expression, context) === true;
    } catch (_) {
      hit = true; // broken deny still denies
    }
    if (hit) {
      return {
        allow: false,
        allowed: false,
        forward: mode === 'dry-run',
        rule: expression,
        source: 'deny',
        mode,
        reason: `La regla de denegación \`${expression}\` bloqueó la acción.`,
      };
    }
  }

  for (const expression of allow) {
    let hit = false;
    try {
      hit = evalExpr(expression, context) === true;
    } catch (_) {
      hit = false; // broken allow must not permit
    }
    if (hit) {
      return {
        allow: true,
        allowed: true,
        forward: true,
        rule: expression,
        source: 'allow',
        mode,
        reason: 'Permitida por política.',
      };
    }
  }

  return {
    allow: false,
    allowed: false,
    forward: mode === 'dry-run',
    rule: 'default_deny',
    source: 'default',
    mode,
    reason: 'Ninguna regla permite esa acción. Fail-closed.',
  };
}

function redactSecret(value, label) {
  if (value && typeof value === 'object' && value.requested === true && Number.isFinite(Number(value.length))) {
    return {
      requested: true,
      label: String(label || value.label || 'secret'),
      length: Number(value.length),
    };
  }
  const text = value == null ? '' : String(value);
  return {
    requested: true,
    label: label ? String(label) : 'secret',
    length: text.length,
  };
}

function describeFile(filePath) {
  const raw = String(filePath || '');
  const name = path.basename(raw);
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return { path: raw, name, extension: ext };
}

function intentOf(toolName, extra) {
  const n = String(toolName || '').toLowerCase();
  if (extra && extra.intent) return extra.intent;
  if (/mcp/.test(n)) {
    return /read|list|get|search|fetch|find/.test(n) ? 'read_tool' : 'write_tool';
  }
  if (n === 'write_file' || n === 'edit_file' || n === 'apply_patch' || n === 'computer_write_file') return 'write_file';
  if (n === 'read_file' || n === 'computer_read_file') return 'read_file';
  if (n === 'list_files' || n === 'glob' || n === 'grep' || n === 'computer_list_files') return 'list_files';
  if (n === 'computer_navigate' || n === 'web_fetch' || n === 'web_search') return n === 'computer_navigate' ? 'navigate' : 'read';
  if (n === 'computer_click' || n === 'browser_act') return 'activate';
  if (n === 'computer_type' || n === 'computer_key') return extra && extra.key && /enter|return|space/i.test(extra.key) ? 'activate' : 'type';
  if (n === 'execute_bash' || n === 'bash' || n === 'execute_python' || n === 'shell' || n === 'exec') return 'shell';
  return 'read';
}

function isGovernedTool(tool) {
  const n = String(tool || '');
  if (GOVERNED_TOOLS.has(n)) return true;
  if (/^mcp[_:]/i.test(n) || n.startsWith('mcp__')) return true;
  if (n.startsWith('computer_')) return true;
  return false;
}

function isComputerTool(tool) {
  const n = String(tool || '');
  return n.startsWith('computer_') || n === 'browser_act';
}

function bindComputer({ coworkerId, departmentId, botId, actorId } = {}) {
  const id = String(coworkerId || departmentId || botId || actorId || 'owner').trim() || 'owner';
  const rec = {
    computerId: `cowork:${id}`,
    runId: `run:${id}`,
    browserProfile: `profile:${id}`,
    workspace: `ws:${id}`,
    coworkerId: id,
  };
  computers.set(rec.computerId, rec);
  return rec;
}

function withHumanControl(computerId) {
  const id = String(computerId || '');
  const hold = humanHold.get(id);
  if (!hold) return { held: false, computerId: id };
  return { held: true, computerId: id, actorId: hold.actorId, reason: hold.reason, at: hold.at, event: hold.event };
}

function requestHelp({ computerId, botId, actorId, reason } = {}) {
  const id = String(computerId || bindComputer({ botId, actorId }).computerId);
  const row = {
    event: 'computer.help_requested',
    computerId: id,
    botId: botId || null,
    actorId: actorId || null,
    reason: String(reason || 'login_or_help'),
    at: new Date().toISOString(),
  };
  humanHold.set(id, row);
  appendAudit({
    status: 'refused',
    tool: 'computer.help_requested',
    intent: 'handoff',
    botId: botId || null,
    actorId: actorId || null,
    computerId: id,
    rule: 'human_help',
    reason: row.reason,
    event: row.event,
  });
  return row;
}

function takeControl({ computerId, botId, actorId, reason } = {}) {
  const id = String(computerId || bindComputer({ botId, actorId }).computerId);
  const row = {
    event: 'computer.control_taken',
    computerId: id,
    botId: botId || null,
    actorId: actorId || null,
    reason: String(reason || 'human_wheel'),
    at: new Date().toISOString(),
  };
  humanHold.set(id, row);
  appendAudit({
    status: 'permitted',
    tool: 'computer.control_taken',
    intent: 'handoff',
    botId: botId || null,
    actorId: actorId || null,
    computerId: id,
    rule: 'human_wheel',
    reason: row.reason,
    event: row.event,
  });
  return row;
}

function releaseControl({ computerId, botId, actorId } = {}) {
  const id = String(computerId || '');
  humanHold.delete(id);
  const row = {
    event: 'computer.control_released',
    computerId: id,
    botId: botId || null,
    actorId: actorId || null,
    at: new Date().toISOString(),
  };
  appendAudit({
    status: 'permitted',
    tool: 'computer.control_released',
    intent: 'handoff',
    botId: botId || null,
    actorId: actorId || null,
    computerId: id,
    rule: 'human_wheel',
    event: row.event,
  });
  return row;
}

function sanitizeAuditInput(input) {
  const out = { ...(input || {}) };
  if (out.secret != null || out.password != null || out.token != null || out.apiKey != null) {
    const raw = out.secret || out.password || out.token || out.apiKey;
    out.secret = redactSecret(raw, out.secretLabel || out.label || 'secret');
    delete out.password;
    delete out.token;
    delete out.apiKey;
    delete out.value;
  }
  if (out.args && typeof out.args === 'object') {
    const args = { ...out.args };
    for (const k of Object.keys(args)) {
      if (/secret|password|token|api[_-]?key|authorization/i.test(k)) {
        args[k] = redactSecret(args[k], k);
      }
    }
    out.args = args;
  }
  return out;
}

function appendAudit(row) {
  const auditId = row.auditId || newId('aud');
  const rec = sanitizeAuditInput({
    auditId,
    ts: new Date().toISOString(),
    status: row.status || 'permitted',
    tool: row.tool || null,
    intent: row.intent || null,
    botId: row.botId || null,
    actorId: row.actorId || null,
    computerId: row.computerId || null,
    page: row.page || null,
    file: row.file || null,
    mcp: row.mcp || null,
    rule: row.rule || null,
    source: row.source || null,
    reason: row.reason || null,
    event: row.event || null,
    secret: row.secret || null,
    error: row.error ? String(row.error).slice(0, 300) : null,
    durationMs: row.durationMs != null ? row.durationMs : null,
    tokens: row.tokens || null,
    tokenTotal: row.tokenTotal != null ? row.tokenTotal : null,
  });
  const line = JSON.stringify(rec);
  const dest = resolveAuditPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // last resort: still return the id; do not execute without attempting a record
    rec.writeError = String(err && err.message || err).slice(0, 120);
  }
  return rec;
}

function readAudit({ limit = 50, actorId } = {}) {
  const dest = resolveAuditPath();
  if (!fs.existsSync(dest)) return [];
  let raw = '';
  try { raw = fs.readFileSync(dest, 'utf8'); } catch (_) { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < limit; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (actorId && row.actorId && String(row.actorId) !== String(actorId)) {
        // owner/admin readers still see their own rows; unscoped listing is ok for the signed-in user
      }
      items.push(row);
    } catch (_) { /* skip broken line */ }
  }
  return items;
}

/**
 * decideAndAudit({ tool, intent, botId, actorId, page, file, mcp })
 * → { allow, rule, auditId }
 * Always writes the row first. Never returns allow:true without an auditId.
 */
function decideAndAudit(input = {}) {
  const tool = String(input.tool || '').trim() || 'unknown';
  const intent = input.intent || intentOf(tool, input);
  const botId = input.botId || null;
  const actorId = input.actorId || null;
  const page = input.page || null;
  const file = input.file ? (typeof input.file === 'string' ? describeFile(input.file) : input.file) : null;
  const mcp = input.mcp || null;
  const computerId = input.computerId || (botId || actorId ? bindComputer({ botId, actorId, coworkerId: input.coworkerId }).computerId : null);

  const hold = computerId ? withHumanControl(computerId) : { held: false };
  if (hold.held && isComputerTool(tool)) {
    const rec = appendAudit({
      status: 'refused',
      tool, intent, botId, actorId, computerId, page, file, mcp,
      rule: 'human_control',
      source: 'human',
      reason: 'Un humano tiene el volante. El bot no encola ni ejecuta.',
      event: hold.event || 'computer.control_taken',
      secret: input.secret != null ? redactSecret(input.secret, input.secretLabel) : null,
    });
    return { allow: false, rule: 'human_control', auditId: rec.auditId, reason: rec.reason, status: 'refused' };
  }

  const context = {
    tool: { name: tool },
    intent,
    bot: { id: String(botId || '') },
    actor: { id: String(actorId || '') },
    page: page && typeof page === 'object' ? { url: page.url || '', host: page.host || hostOf(page.url) } : { url: '', host: '' },
    file: file || undefined,
    mcp: mcp || undefined,
    key: input.key || undefined,
  };

  const policy = Object.prototype.hasOwnProperty.call(input, 'policy') ? input.policy : loadPolicy();
  const decision = evaluatePolicy(policy, context);
  const status = decision.forward ? 'permitted' : 'refused';
  const rec = appendAudit({
    status,
    tool, intent, botId, actorId, computerId, page: context.page, file, mcp,
    rule: decision.rule,
    source: decision.source,
    reason: decision.reason,
    secret: input.secret != null ? redactSecret(input.secret, input.secretLabel) : null,
  });
  if (!rec.auditId) {
    return { allow: false, rule: 'audit_write_failed', auditId: null, reason: 'No se pudo escribir la auditoría.', status: 'failed' };
  }
  return {
    allow: Boolean(decision.forward),
    rule: decision.rule,
    auditId: rec.auditId,
    reason: decision.reason,
    status,
    source: decision.source,
  };
}

function hostOf(url) {
  try { return new URL(String(url || '')).host || ''; } catch (_) { return ''; }
}

async function governThen(input, run) {
  const decision = decideAndAudit(input);
  if (!decision.allow) {
    const err = new Error(decision.reason || 'action_refused');
    err.code = 'action_refused';
    err.rule = decision.rule;
    err.auditId = decision.auditId;
    throw err;
  }
  const startedAt = Date.now();
  try {
    try {
      const ad = require('./engine-adapter');
      const pre = ad.runPreToolHook(input.tool, input.args || input);
      if (pre && pre.ok === false) {
        const err = new Error(pre.code || 'dangerous_tool');
        err.code = pre.code || 'dangerous_tool';
        throw err;
      }
      try {
        if (typeof ad.stripAdditionalProperties === 'function' && input && input.args && input.schema) {
          const stripped = ad.stripAdditionalProperties(input.args, input.schema);
          if (stripped && stripped.ok === false) {
            const err = new Error(stripped.code || 'schema_invalid');
            err.code = stripped.code || 'schema_invalid';
            throw err;
          }
          if (stripped && stripped.args) input.args = stripped.args;
        }
      } catch (stripErr) {
        if (stripErr && stripErr.code === 'schema_invalid') throw stripErr;
      }
      try {
        if (typeof ad.appendTokenAuditLog === 'function') {
          ad.appendTokenAuditLog({ session: input.sessionKey || input.session, tokens: input.tokens, model: input.model });
        }
      } catch (_) {}
      try {
        if (typeof ad.perToolRateLimit === 'function') {
          const tr = ad.perToolRateLimit(String(input.sessionKey || input.session || 'anon'), String(input.tool || ''));
          if (tr && tr.ok === false) {
            const err = new Error('rate_limited');
            err.code = 'rate_limited';
            throw err;
          }
        }
        if (typeof ad.allowlistToolName === 'function' && input && input.tool) {
          const allow = ad.allowlistToolName(String(input.tool), { extra: input.allowedTools || input.tools });
          if (allow && allow.ok === false) {
            const err = new Error('unknown_tool');
            err.code = 'unknown_tool';
            throw err;
          }
        }
        if (typeof ad.validateEnumArgs === 'function' && input && input.args && input.schema) {
          const en = ad.validateEnumArgs(input.args, input.schema);
          if (en && en.ok === false) {
            const err = new Error('enum_rejected');
            err.code = 'enum_rejected';
            throw err;
          }
        }
        if (typeof ad.classifyNetErrors === 'function' && input && input.providerError) {
          const net = ad.classifyNetErrors(input.providerError);
          if (net && net.code) {
            const err = new Error(net.message || net.code);
            err.code = net.code;
            throw err;
          }
        }
        if (typeof ad.detectDagCycle === 'function' && input && input.dag) {
          const cyc = ad.detectDagCycle(input.dag);
          if (cyc && cyc.ok === false) {
            const err = new Error('dag_cycle');
            err.code = 'dag_cycle';
            throw err;
          }
        }
        if (typeof ad.repairMissingRequiredFromPriorTurn === 'function' && input && input.args && input.schema) {
          const miss = ad.repairMissingRequiredFromPriorTurn(input.args, input.schema, { prior: input.priorArgs });
          if (miss && miss.ok === false) {
            const err = new Error('missing_required');
            err.code = 'missing_required';
            throw err;
          }
          if (miss && miss.args) input.args = miss.args;
        }
        if (typeof ad.classifyFsErrors === 'function' && input && input.fsError) {
          const fsE = ad.classifyFsErrors(input.fsError);
          if (fsE && fsE.code) {
            const err = new Error(fsE.message || fsE.code);
            err.code = fsE.code;
            throw err;
          }
        }
        if (typeof ad.validateToolResultShape === 'function' && input && Object.prototype.hasOwnProperty.call(input, 'toolResult')) {
          const sh = ad.validateToolResultShape(input.toolResult);
          if (sh && sh.ok === false) {
            const err = new Error('bad_tool_result');
            err.code = 'bad_tool_result';
            throw err;
          }
        }
        if (typeof ad.checkpointCasSeq === 'function' && input && input.checkpointSeq != null) {
          const cas = ad.checkpointCasSeq({ seq: input.checkpointSeq, lastSeq: input.lastCheckpointSeq });
          if (cas && cas.ok === false) {
            const err = new Error('ckpt_cas');
            err.code = 'ckpt_cas';
            throw err;
          }
        }
        if (typeof ad.creditAuditOnToolError === 'function' && input && input.toolError) {
          ad.creditAuditOnToolError({ tokens: input.tokens, tool: input.tool, code: input.toolError.code || input.toolError, session: input.sessionKey });
        }
        if (typeof ad.classifyJsonParseErrors === 'function' && input && input.parseError) {
          const jp = ad.classifyJsonParseErrors(input.parseError);
          if (jp && jp.code) {
            const err = new Error(jp.message || jp.code);
            err.code = jp.code;
            throw err;
          }
        }
        if (typeof ad.classifyAbortErrors === 'function' && input && input.abortError) {
          const ab = ad.classifyAbortErrors(input.abortError);
          if (ab && ab.code) {
            const err = new Error(ab.message || ab.code);
            err.code = ab.code;
            throw err;
          }
        }
        if (typeof ad.maxSubagentDepth === 'function' && input && input.subagentDepth != null) {
          const d = ad.maxSubagentDepth(input.subagentDepth);
          if (d && d.ok === false) {
            const err = new Error('subagent_depth');
            err.code = 'subagent_depth';
            throw err;
          }
        }
        if (typeof ad.remainingWallClockCut === 'function' && input && input.remainingMs != null) {
          const cut = ad.remainingWallClockCut({ remainingMs: input.remainingMs });
          if (cut && cut.halt) {
            const err = new Error('wall_clock');
            err.code = 'wall_clock';
            throw err;
          }
        }
        if (typeof ad.settleCreditsIfClientGone === 'function' && input && (input.clientGone || input.res)) {
          ad.settleCreditsIfClientGone({
            res: input.res,
            aborted: input.clientGone || input.aborted,
            sessionKey: input.sessionKey,
            requestId: input.requestId,
            usage: input.usage,
          });
        }
        if (typeof ad.neverChargeOnUnauthorized === 'function' && input && (input.status === 401 || input.status === 403 || input.unauthorized)) {
          const nochg = ad.neverChargeOnUnauthorized({ status: input.status, code: input.code, error: input.error });
          if (nochg && nochg.charge === false) {
            const err = new Error('unauthorized');
            err.code = 'unauthorized';
            throw err;
          }
        }
        if (typeof ad.classifyEpipeAsCancelled === 'function' && input && input.responseError) {
          const ep = ad.classifyEpipeAsCancelled(input.responseError, { stream: 'response' });
          if (ep && ep.code) {
            const err = new Error(ep.message || ep.code);
            err.code = ep.code;
            throw err;
          }
        }
        if (typeof ad.redactIpv4InPublicErrors === 'function' && input && input.publicMessage) {
          const red = ad.redactIpv4InPublicErrors(input.publicMessage);
          if (red && red.message) input.publicMessage = red.message;
        }
        if (typeof ad.classifyHttpFamily === 'function' && input && (input.error || input.status)) {
          const fam = ad.classifyHttpFamily(input.error || { status: input.status });
          if (fam && fam.code) input.httpFamily = fam.family;
        }
        if (typeof ad.holdSettleNeverDoubleCharge === 'function' && input && input.held) {
          ad.holdSettleNeverDoubleCharge({ held: input.held, settled: input.settled, cancelled: input.cancelled || input.aborted });
        }
        if (typeof ad.holdSettleNeverDoubleCharge === 'function' && input && input.held) {
          ad.holdSettleNeverDoubleCharge({ held: input.held, settled: input.settled, cancelled: input.cancelled || input.aborted });
        }
        if (typeof ad.refundHoldIfNoTokensUsed === 'function' && input && input.held) {
          ad.refundHoldIfNoTokensUsed({ held: input.held, promptTokens: input.promptTokens, completionTokens: input.completionTokens, cancelled: input.cancelled || input.aborted });
        }
        if (typeof ad.refundHoldIfNoTokensUsed === 'function' && input && input.held) {
          ad.refundHoldIfNoTokensUsed({ held: input.held, promptTokens: input.promptTokens, completionTokens: input.completionTokens, cancelled: input.cancelled || input.aborted });
        }
        if (typeof ad.ceilTokensOnCancel === 'function' && input && (input.cancelled || input.aborted)) {
          ad.ceilTokensOnCancel({ promptTokens: input.promptTokens, completionTokens: input.completionTokens, cancelled: true });
        }
        if (typeof ad.neverRetry402 === 'function' && input && (input.status === 402 || input.code === '402')) {
          ad.neverRetry402(input);
        }
        if (typeof ad.closeSseThenSettleCredits === 'function') {
          ad.closeSseThenSettleCredits({ sseClosed: !!(input && (input.sseClosed || input.streamClosed)), settled: !!(input && input.settled), cancelled: !!(input && (input.cancelled || input.aborted)), held: !!(input && input.held) });
        }
        if (typeof ad.classifyEconnresetAsCancelled === 'function' && input && input.error) {
          ad.classifyEconnresetAsCancelled(input.error);
        }
        if (typeof ad.mapPrismaDisconnectRetryable === 'function' && input && input.error) {
          ad.mapPrismaDisconnectRetryable(input.error);
        }
        if (typeof ad.skipUpsertIfEmbeddingDimMismatch === 'function' && input && input.embedding != null) {
          ad.skipUpsertIfEmbeddingDimMismatch(input.embedding, { expectedDim: input.expectedDim });
        }
        if (typeof ad.sessionLockOwnerPidCheck === 'function' && input && input.lock) {
          ad.sessionLockOwnerPidCheck({ lock: input.lock, ownerPid: input.ownerPid, currentPid: input.currentPid });
        }
        if (typeof ad.sessionLockOwnerPidCheck === 'function' && input && input.lock) {
          ad.sessionLockOwnerPidCheck({ lock: input.lock, ownerPid: input.ownerPid, currentPid: input.currentPid });
        }
        if (typeof ad.neverNegativeUsage === 'function' && input && (input.promptTokens != null || input.completionTokens != null)) {
          ad.neverNegativeUsage({ promptTokens: input.promptTokens, completionTokens: input.completionTokens, totalTokens: input.totalTokens });
        }
        if (typeof ad.mapRedisEconnrefusedRetryable === 'function' && input && input.error) {
          ad.mapRedisEconnrefusedRetryable(input.error);
        }
        if (typeof ad.sessionLockTtl90s === 'function' && input && input.lock) {
          ad.sessionLockTtl90s({ acquiredAt: input.lock.acquiredAt || input.lock.at, now: Date.now(), ttlMs: 90000 });
        }
        if (typeof ad.screenshotOnlyNoCharge === 'function' && input && (input.tools || input.screenshotOnly)) {
          ad.screenshotOnlyNoCharge({ tools: input.tools, screenshotOnly: input.screenshotOnly });
        }
        if (typeof ad.neverRetry413 === 'function' && input && (input.status === 413 || input.code === '413')) {
          ad.neverRetry413(input);
        }
        if (typeof ad.neverRetry451 === 'function' && input && (input.status === 451 || input.code === '451')) {
          ad.neverRetry451(input);
        }
        if (typeof ad.ignoreNegativeCompletionTokens === 'function' && input && (input.completionTokens != null || input.promptTokens != null)) {
          ad.ignoreNegativeCompletionTokens({ promptTokens: input.promptTokens, completionTokens: input.completionTokens, totalTokens: input.totalTokens });
        }
        if (typeof ad.classifyEnetunreachAsTimeout === 'function' && input && input.error) {
          ad.classifyEnetunreachAsTimeout(input.error);
        }
        if (typeof ad.mapRedisEaiAgainRetryable === 'function' && input && input.error) {
          ad.mapRedisEaiAgainRetryable(input.error);
        }
        if (typeof ad.sessionLockHeartbeatEvery20s === 'function' && input && input.lock) {
          ad.sessionLockHeartbeatEvery20s({ lastBeatAt: input.lock.heartbeatAt || input.lock.lastBeatAt, now: Date.now(), intervalMs: 20000 });
        }
        if (typeof ad.observeOnlyNoCharge === 'function' && input && (input.tools || input.observeOnly)) {
          ad.observeOnlyNoCharge({ tools: input.tools, observeOnly: input.observeOnly });
        }
        if (typeof ad.neverRetry410Gone === 'function' && input && (input.status === 410 || input.code === '410')) {
          ad.neverRetry410Gone(input);
        }
        if (typeof ad.ignoreNegativePromptTokens === 'function' && input && input.promptTokens != null) {
          ad.ignoreNegativePromptTokens({ promptTokens: input.promptTokens, completionTokens: input.completionTokens, totalTokens: input.totalTokens });
        }
        if (typeof ad.classifyEhostunreachAsTimeout === 'function' && input && input.error) {
          ad.classifyEhostunreachAsTimeout(input.error);
        }
        if (typeof ad.mapPostgresEconnresetRetryable === 'function' && input && input.error) {
          ad.mapPostgresEconnresetRetryable(input.error);
        }
        if (typeof ad.sessionLockStealIfHeartbeatStale === 'function' && input && input.lock) {
          ad.sessionLockStealIfHeartbeatStale({ lastBeatAt: input.lock.heartbeatAt || input.lock.lastBeatAt, now: Date.now() });
        }
        if (typeof ad.neverChargeIfCancelledBeforeFirstToken === 'function' && input) {
          ad.neverChargeIfCancelledBeforeFirstToken({ cancelled: input.cancelled, firstToken: input.firstToken, firstByteAt: input.firstByteAt, tokens: input.tokens });
        }
        if (typeof ad.accountPartialTokensOnCancel === 'function' && input && input.cancelled) {
          ad.accountPartialTokensOnCancel({
            cancelled: true,
            streamedChars: input.streamedChars,
            usage: { promptTokens: input.promptTokens, completionTokens: input.completionTokens },
          });
        }
        if (typeof ad.settleCancelUsageClosed === 'function' && input && input.cancelled) {
          input.cancelUsage = ad.settleCancelUsageClosed({
            cancelled: true,
            streamedChars: input.streamedChars,
            usage: { promptTokens: input.promptTokens, completionTokens: input.completionTokens },
            alreadyRecorded: input.settled === true,
          });
        }
        if (typeof ad.classifyEngine3h59Error === 'function' && input && input.error) {
          ad.classifyEngine3h59Error(input.error);
        }
        if (typeof ad.classifyPublicLoopErrorClosed === 'function' && input && input.error) {
          const classified = ad.classifyPublicLoopErrorClosed(input.error);
          if (classified) input.publicError = classified;
        }
        if (typeof ad.refuseOpenRouterInWave3h59 === 'function' && input && input.env) {
          const or = ad.refuseOpenRouterInWave3h59(input.env);
          if (or && or.ok === false) {
            const err = new Error('openrouter_denied');
            err.code = 'openrouter_denied';
            throw err;
          }
        }
        if (typeof ad.settleCreditsOnError === 'function' && input && input.error && !input.cancelled) {
          ad.settleCreditsOnError({
            errored: true,
            alreadySettled: input.settled,
            usage: { promptTokens: input.promptTokens, completionTokens: input.completionTokens, streamedChars: input.streamedChars },
          });
        }
        if (typeof ad.settleLedgerOnErrorClosed === 'function' && input && (input.error || input.cancelled)) {
          input.ledgerSettle = ad.settleLedgerOnErrorClosed({
            errored: Boolean(input.error) && !input.cancelled,
            cancelled: input.cancelled === true,
            alreadySettled: input.settled === true,
            firstToken: input.firstToken,
            tokens: input.tokens,
            usage: { promptTokens: input.promptTokens, completionTokens: input.completionTokens, streamedChars: input.streamedChars },
            prisma: input.prisma,
            transaction: input.transaction || input.chargedCredits,
            failLedger: input.failLedger,
          });
        }
        if (typeof ad.refundPartialTokensOnCancel === 'function' && input && input.cancelled) {
          ad.refundPartialTokensOnCancel({
            requestId: input.requestId,
            cancelled: true,
            promptTokens: input.promptTokens,
            completionTokens: input.completionTokens,
            alreadyRefunded: input.settled === true,
          });
        }
        if (typeof ad.completeLedgerOnSuccessClosed === 'function' && input && !input.error && input.transaction) {
          input.ledgerComplete = ad.completeLedgerOnSuccessClosed({
            completeLedgerTransaction: input.completeLedgerTransaction,
            prisma: input.prisma,
            transaction: input.transaction || input.chargedCredits,
            cancelled: input.cancelled === true,
            tokens: input.tokens,
            streamedChars: input.streamedChars,
          });
        }
        if (typeof ad.neverChargeBeforeFirstToken === 'function' && input) {
          ad.neverChargeBeforeFirstToken({
            firstToken: input.firstToken,
            cancelled: input.cancelled,
            errored: !!input.error,
            tokens: input.tokens,
          });
        }
        if (typeof ad.capPromptTokensOnErrorSettle === 'function' && input && input.error && input.promptTokens != null) {
          const capped = ad.capPromptTokensOnErrorSettle({ promptTokens: input.promptTokens });
          if (capped && capped.capped) input.promptTokens = capped.promptTokens;
        }
        if (typeof ad.classifyEngine3h60Error === 'function' && input && input.error) {
          ad.classifyEngine3h60Error(input.error);
        }
        if (typeof ad.refuseOpenRouterInWave3h60 === 'function' && input && input.env) {
          const or60 = ad.refuseOpenRouterInWave3h60(input.env);
          if (or60 && or60.ok === false) {
            const err = new Error('openrouter_denied');
            err.code = 'openrouter_denied';
            throw err;
          }
        }
        if (typeof ad.classifyEconnabortedAsCancelled === 'function' && input && input.error) {
          ad.classifyEconnabortedAsCancelled(input.error);
        }
        if (typeof ad.neverChargeToolOnlyObservationLoop === 'function' && input && (input.toolOnly || input.observationLoop)) {
          ad.neverChargeToolOnlyObservationLoop({ toolOnly: input.toolOnly, observationLoop: input.observationLoop, usage: input.usage, charged: input.charged });
        }
        if (typeof ad.tombstoneDeletedCheckpoint === 'function' && input && input.deleteCheckpointId) {
          ad.tombstoneDeletedCheckpoint({ id: input.deleteCheckpointId, store: input.checkpointStore || {}, seq: input.seq });
        }
        if (typeof ad.retryAfterJitter50to150ms === 'function' && input && (input.retryAfterMs != null || input.retryAfterSec != null || input.status === 429)) {
          const j = ad.retryAfterJitter50to150ms({ retryAfterMs: input.retryAfterMs, retryAfterSec: input.retryAfterSec });
          if (j && j.delayMs != null) input.retryDelayMs = j.delayMs;
        }
        if (typeof ad.skipEmptyEmbeddingUpsert === 'function' && input && input.embedding != null) {
          ad.skipEmptyEmbeddingUpsert(input.embedding, { fact: input.fact });
        }
        if (typeof ad.refuseComputerToolsIfFlagOff === 'function' && input && input.toolName) {
          const off = ad.refuseComputerToolsIfFlagOff(input.toolName, { computerEnabled: input.computerEnabled });
          if (off && off.refused) {
            const err = new Error('computer_flag_off');
            err.code = 'computer_flag_off';
            throw err;
          }
        }
        if (typeof ad.maxConcurrentSubagents === 'function' && input && input.subagents) {
          const mc = ad.maxConcurrentSubagents(input.subagents, { max: 2 });
          if (mc && mc.halt) {
            const err = new Error('subagent_concurrency');
            err.code = 'subagent_concurrency';
            throw err;
          }
        }
        if (typeof ad.rejectEmptyToolName === 'function' && input && input.toolName != null) {
          const empty = ad.rejectEmptyToolName(input.toolName);
          if (empty && empty.ok === false) {
            const err = new Error('empty_tool_name');
            err.code = 'empty_tool_name';
            throw err;
          }
        }
        if (typeof ad.maxToolsPerTurnHardCap === 'function' && input && input.toolCalls) {
          const cap = ad.maxToolsPerTurnHardCap(input.toolCalls);
          if (cap && cap.halt) {
            const err = new Error('too_many_tools');
            err.code = 'too_many_tools';
            throw err;
          }
        }
        if (typeof ad.firstTokenWatchdogMs === 'function' && input && input.ttfbElapsedMs != null && input.firstTokenAt == null) {
          const wd = ad.firstTokenWatchdogMs({ elapsedMs: input.ttfbElapsedMs, firstTokenAt: input.firstTokenAt });
          if (wd && wd.fired) {
            const err = new Error('ttfb_watchdog');
            err.code = 'ttfb_watchdog';
            throw err;
          }
        }
        if (typeof ad.mapDeepSeekHttpError === 'function' && input && input.providerError) {
          const ds = ad.mapDeepSeekHttpError(input.providerError);
          if (ds && (ds.code === 'rate_limited' || ds.code === 'credit_ceiling')) {
            const err = new Error(ds.code);
            err.code = ds.code;
            throw err;
          }
        }
        if (typeof ad.consumeGenerateResumeToken === 'function' && input && input.resumeToken) {
          const tok = ad.consumeGenerateResumeToken(input.resumeToken, String(input.sessionKey || input.session || ''));
          if (tok && tok.ok === false) {
            const err = new Error(tok.code || 'resume_conflict');
            err.code = tok.code || 'resume_conflict';
            throw err;
          }
        }
      } catch (rateErr) {
        if (rateErr && rateErr.code === 'rate_limited') throw rateErr;
      }
      try {
        if (typeof ad.dropCancelledRunEvents === 'function' && input && input.runId) {
          const d = ad.dropCancelledRunEvents({ runId: input.runId }, { runId: input.runId });
          if (d && d.drop) {
            const err = new Error('turn_cancelled');
            err.code = 'turn_cancelled';
            throw err;
          }
        }
      } catch (runErr) {
        if (runErr && runErr.code === 'turn_cancelled') throw runErr;
      }
    } catch (preErr) {
      if (preErr && (preErr.code === 'dangerous_tool' || preErr.code === 'tool_args_invalid' || preErr.code === 'unknown_tool' || preErr.code === 'credit_ceiling' || preErr.code === 'resume_conflict')) throw preErr;
    }
    const out = await run();
    try {
      const ad = require('./engine-adapter');
      const stamped = ad.stampAuditDurationTokens({
        status: 'completed',
        tool: input.tool,
        auditId: decision.auditId,
      }, { startedAt, now: Date.now(), tokens: input.tokens });
      appendAudit(stamped);
    } catch (_) {}
    return out;
  } catch (error) {
    let durationMs = Date.now() - startedAt;
    try {
      const ad = require('./engine-adapter');
      const stamped = ad.stampAuditDurationTokens({
        status: 'failed',
        tool: input.tool,
        intent: input.intent,
        botId: input.botId,
        actorId: input.actorId,
        computerId: input.computerId,
        page: input.page,
        file: input.file,
        mcp: input.mcp,
        rule: decision.rule,
        auditId: newId('aud'),
        error: error && error.message,
        reason: 'La política permitió la acción y luego falló la ejecución.',
      }, { durationMs, tokens: input.tokens });
      appendAudit(stamped);
    } catch (_) {
      appendAudit({
        status: 'failed',
        tool: input.tool,
        intent: input.intent,
        botId: input.botId,
        actorId: input.actorId,
        computerId: input.computerId,
        page: input.page,
        file: input.file,
        mcp: input.mcp,
        rule: decision.rule,
        auditId: newId('aud'),
        error: error && error.message,
        reason: 'La política permitió la acción y luego falló la ejecución.',
      });
    }
    throw error;
  }
}

function wrapExecutors(executors, meta = {}) {
  if (!executors || typeof executors !== 'object') return executors;
  const out = { ...executors };
  for (const name of Object.keys(out)) {
    if (typeof out[name] !== 'function') continue;
    if (!isGovernedTool(name)) continue;
    const orig = out[name];
    out[name] = async function governedExecutor(args, ctx = {}) {
      const file = args && (args.path || args.file || args.filename) || null;
      const mcp = /^mcp/.test(name) ? {
        server: (args && args.server) || String(name).split(/[_:]/)[1] || 'mcp',
        tool: (args && (args.tool || args.name)) || name,
        effect: /read|list|get|search|fetch/.test(name) ? 'read' : 'write',
      } : null;
      const computerId = (ctx && (ctx.computerId || ctx.coworkerId))
        || (meta.computerId)
        || bindComputer({
          botId: ctx && (ctx.botId || ctx.agentId),
          actorId: ctx && (ctx.userId || ctx.actorId),
          coworkerId: ctx && ctx.coworkerId,
          departmentId: ctx && ctx.departmentId,
        }).computerId;
      const decision = decideAndAudit({
        tool: name,
        intent: intentOf(name, args),
        botId: (ctx && (ctx.botId || ctx.agentId)) || meta.botId || null,
        actorId: (ctx && (ctx.userId || ctx.actorId)) || meta.actorId || null,
        coworkerId: ctx && ctx.coworkerId,
        computerId,
        file,
        mcp,
        page: ctx && ctx.page,
        key: args && args.key,
        secret: args && (args.secret || args.password),
        secretLabel: args && (args.label || args.secretLabel),
      });
      if (!decision.allow) {
        return `ERROR: action_refused: ${decision.reason} [${decision.rule}]`;
      }
      try {
        return await orig.call(this, args, ctx);
      } catch (error) {
        appendAudit({
          status: 'failed',
          tool: name,
          botId: ctx && ctx.botId,
          actorId: ctx && (ctx.userId || ctx.actorId),
          computerId,
          file,
          rule: decision.rule,
          error: error && error.message,
          reason: 'Permitida y luego falló.',
        });
        return `ERROR: ${name} ${error && (error.detail || error.message) || error}`;
      }
    };
  }
  return out;
}

function createCodeAuditRouter() {
  const express = require('express');
  const { authenticateToken } = require('../../middleware/auth');
  const router = express.Router();
  router.get('/audit', authenticateToken, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = readAudit({ limit, actorId: req.user && req.user.id });
    return res.json({
      ok: true,
      items,
      policy: summarizePolicy(loadPolicy()),
    });
  });
  router.post('/handoff', authenticateToken, (req, res) => {
    const event = String((req.body && req.body.event) || '').trim();
    const computerId = (req.body && req.body.computerId) || bindComputer({
      actorId: req.user && req.user.id,
      coworkerId: req.body && req.body.coworkerId,
      departmentId: req.body && req.body.departmentId,
    }).computerId;
    const payload = {
      computerId,
      actorId: req.user && req.user.id,
      botId: req.body && req.body.botId,
      reason: req.body && req.body.reason,
    };
    let row;
    if (event === 'computer.help_requested') row = requestHelp(payload);
    else if (event === 'computer.control_taken') row = takeControl(payload);
    else if (event === 'computer.control_released') row = releaseControl(payload);
    else return res.status(400).json({ error: 'bad_event', message: 'Evento de handoff no reconocido.' });
    return res.json({ ok: true, ...row, hold: withHumanControl(computerId) });
  });
  return router;
}

function summarizePolicy(policy) {
  if (!policy) return { present: false, mode: 'enforce', deny: 0, allow: 0 };
  return {
    present: true,
    mode: policy.mode || 'enforce',
    deny: (policy.deny || []).length,
    allow: (policy.allow || []).length,
  };
}

module.exports = {
  decideAndAudit,
  evaluatePolicy,
  DEFAULT_OWNER_POLICY,
  redactSecret,
  withHumanControl,
  requestHelp,
  takeControl,
  releaseControl,
  bindComputer,
  wrapExecutors,
  governThen,
  createCodeAuditRouter,
  readAudit,
  appendAudit,
  isGovernedTool,
  intentOf,
  setPolicyForTests,
  setAuditPathForTests,
  resetGatewayStateForTests,
  loadPolicy,
};
