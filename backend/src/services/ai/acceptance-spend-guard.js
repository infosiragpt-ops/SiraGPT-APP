'use strict';

// Private operator-controlled acceptance campaign, not application billing.
// All emitting processes must use the SAME durable local filesystem ledger.
// A missing ledger/lock recovery is deliberately an operator action, never an
// automatic reset. No provider result (including success) releases a reserve.
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
const MODEL = 'muse-spark-1.3-contributor';
const ONE_USD_MICROS = 1_000_000;
const MAX_TOTAL_MICROS = 5 * ONE_USD_MICROS;
const MAX_INPUT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_BODY_BYTES = 1_000_000;
const PUBLIC_MESSAGE = 'La prueba no puede continuar con el presupuesto acreditado. Revisa la campaña de pruebas.';

function denied(reason) {
  const error = new Error(PUBLIC_MESSAGE);
  Object.assign(error, {
    name: 'AcceptanceSpendError', code: 'E_QUOTA', status: 402,
    terminal: true, retryable: false, acceptanceSpendGuard: true, reason,
  });
  return error;
}

function isAcceptanceSpendError(error) {
  const seen = new Set();
  for (let depth = 0; error && depth < 8 && !seen.has(error); depth += 1) {
    if (error.acceptanceSpendGuard === true && error.code === 'E_QUOTA') return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function keysOnly(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function tokenCostCeilingMicros(rateMicrosPerMillion, tokens) {
  // Both operands were validated as safe integers. Products can exceed the
  // Number safe range, so use exact integers and round EACH component upward.
  return (BigInt(rateMicrosPerMillion) * BigInt(tokens) + 999_999n) / 1_000_000n;
}

function strictReadJson(filename, disk, maxBytes = 16_384) {
  let fd;
  try {
    fd = disk.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = disk.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw denied('private_file_invalid');
    }
    return JSON.parse(disk.readFileSync(fd, 'utf8'));
  } finally {
    if (fd !== undefined) disk.closeSync(fd);
  }
}

function readPolicy(filename, disk) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw denied('policy_invalid');
    const policyDirectory = disk.realpathSync(path.dirname(filename));
    const policyDirectoryStat = disk.statSync(policyDirectory);
    if (!policyDirectoryStat.isDirectory() || (policyDirectoryStat.mode & 0o022) !== 0) throw denied('policy_invalid');
    const policy = strictReadJson(filename, disk);
    if (!keysOnly(policy, ['version', 'campaignId', 'userId', 'chatId', 'expiresAt', 'ledgerPath',
      'maxTotalMicros', 'reservationMicros', 'pricing']) || policy.version !== 1
      || !identifier(policy.campaignId) || !identifier(policy.userId) || !identifier(policy.chatId)
      || typeof policy.expiresAt !== 'string' || !Number.isFinite(Date.parse(policy.expiresAt))
      || typeof policy.ledgerPath !== 'string' || !path.isAbsolute(policy.ledgerPath)
      || !integer(policy.maxTotalMicros, ONE_USD_MICROS, MAX_TOTAL_MICROS)
      || policy.reservationMicros !== ONE_USD_MICROS) throw denied('policy_invalid');
    const pricing = policy.pricing;
    if (!keysOnly(pricing, ['verified', 'inputMicrosPerMillion', 'outputMicrosPerMillion',
      'inputTokenCeiling', 'outputTokenCeiling']) || typeof pricing.verified !== 'boolean'
      || !integer(pricing.inputMicrosPerMillion, 0, Number.MAX_SAFE_INTEGER)
      || !integer(pricing.outputMicrosPerMillion, 0, Number.MAX_SAFE_INTEGER)
      || pricing.inputTokenCeiling !== MAX_INPUT_TOKENS || pricing.outputTokenCeiling !== MAX_OUTPUT_TOKENS
      || (pricing.inputMicrosPerMillion === 0 && pricing.outputMicrosPerMillion === 0)) {
      throw denied('policy_invalid');
    }
    // max_tokens includes reasoning and final output; the guard enforces this
    // output ceiling on every physical send. Context uses the full 2^20 bound.
    const reserveCeiling = tokenCostCeilingMicros(pricing.inputMicrosPerMillion, pricing.inputTokenCeiling)
      + tokenCostCeilingMicros(pricing.outputMicrosPerMillion, pricing.outputTokenCeiling);
    if (reserveCeiling > BigInt(policy.reservationMicros)) {
      throw denied('policy_invalid');
    }
    // A private directory prevents other users from replacing a ledger or lock.
    const directory = disk.realpathSync(path.dirname(policy.ledgerPath));
    const directoryStat = disk.statSync(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o022) !== 0) throw denied('policy_invalid');
    const ledgerPath = path.join(directory, path.basename(policy.ledgerPath));
    if (ledgerPath === disk.realpathSync(filename)) throw denied('policy_invalid');
    return Object.freeze({ ...policy, pricing: Object.freeze({ ...pricing }),
      expiresAtMs: Date.parse(policy.expiresAt), ledgerPath });
  } catch (_) {
    throw denied('policy_invalid');
  }
}

function readLedger(policy, disk) {
  try {
    const ledger = strictReadJson(policy.ledgerPath, disk);
    if (!keysOnly(ledger, ['version', 'campaignId', 'maxTotalMicros', 'reservationMicros', 'usedMicros', 'reservations'])
      || ledger.version !== 1 || ledger.campaignId !== policy.campaignId
      || ledger.maxTotalMicros !== policy.maxTotalMicros || ledger.reservationMicros !== policy.reservationMicros
      || !Array.isArray(ledger.reservations) || ledger.reservations.length > 5
      || !integer(ledger.usedMicros, 0, policy.maxTotalMicros)
      || ledger.usedMicros !== ledger.reservations.length * policy.reservationMicros
      || !ledger.reservations.every((item, index) => keysOnly(item, ['sequence', 'reservedMicros', 'atMs'])
        && item.sequence === index + 1 && item.reservedMicros === policy.reservationMicros
        && integer(item.atMs, 0, Number.MAX_SAFE_INTEGER))) throw denied('ledger_invalid');
    return ledger;
  } catch (_) {
    throw denied('ledger_unavailable');
  }
}

function functionCall(value) {
  return keysOnly(value, ['name', 'arguments']) && identifier(value.name)
    && typeof value.arguments === 'string';
}

function textMessage(message) {
  if (!keysOnly(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls'])
    || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
    || (message.name !== undefined && !identifier(message.name))
    || (message.tool_call_id !== undefined && !identifier(message.tool_call_id))) return false;
  const calls = message.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 128 || !calls.every((call) =>
    keysOnly(call, ['id', 'type', 'function']) && identifier(call.id)
      && call.type === 'function' && functionCall(call.function)))) return false;
  return typeof message.content === 'string'
    || (message.content === null && message.role === 'assistant' && calls?.length > 0)
    || (Array.isArray(message.content) && message.content.length <= 1024 && message.content.every((part) =>
      keysOnly(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string'));
}

function validTool(tool) {
  return keysOnly(tool, ['type', 'function']) && tool.type === 'function'
    && keysOnly(tool.function, ['name', 'description', 'parameters', 'strict'])
    && identifier(tool.function.name)
    && (tool.function.description === undefined || typeof tool.function.description === 'string')
    && (tool.function.parameters === undefined || plain(tool.function.parameters))
    && (tool.function.strict === undefined || typeof tool.function.strict === 'boolean');
}

function validateRequest(input, init) {
  // Request/URL objects and streaming bodies are mutable across the durable
  // reservation. Only immutable URL/body strings can be accredited here.
  if (input !== ENDPOINT || !plain(init) || init.method !== 'POST'
    || typeof init.body !== 'string' || Buffer.byteLength(init.body, 'utf8') > MAX_BODY_BYTES) {
    throw denied('operation_denied');
  }
  let body;
  try { body = JSON.parse(init.body); } catch (_) { throw denied('operation_denied'); }
  if (!keysOnly(body, ['model', 'messages', 'max_tokens', 'stream', 'stream_options', 'temperature',
    'top_p', 'reasoning_effort', 'tools', 'tool_choice', 'parallel_tool_calls', 'n'])
    || body.model !== MODEL || !integer(body.max_tokens, 1, MAX_OUTPUT_TOKENS)
    || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 1024
    || !body.messages.every(textMessage)
    || (body.stream !== undefined && typeof body.stream !== 'boolean')
    || (body.n !== undefined && body.n !== 1)
    || (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean')
    || (body.temperature !== undefined && !(typeof body.temperature === 'number' && Number.isFinite(body.temperature)
      && body.temperature >= 0 && body.temperature <= 2))
    || (body.top_p !== undefined && !(typeof body.top_p === 'number' && Number.isFinite(body.top_p)
      && body.top_p >= 0 && body.top_p <= 1))
    || (body.reasoning_effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(body.reasoning_effort))
    || (body.stream_options !== undefined && !(keysOnly(body.stream_options, ['include_usage'])
      && typeof body.stream_options.include_usage === 'boolean'))
    || (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.length <= 128 && body.tools.every(validTool)))) {
    throw denied('operation_denied');
  }
  if (body.tool_choice !== undefined && !['none', 'auto', 'required'].includes(body.tool_choice)
    && !(keysOnly(body.tool_choice, ['type', 'function']) && body.tool_choice.type === 'function'
      && keysOnly(body.tool_choice.function, ['name']) && identifier(body.tool_choice.function.name))) {
    throw denied('operation_denied');
  }
}

function createAcceptanceSpendGuard({ policyFile = '', clock = Date.now, fsImpl = fs } = {}) {
  const disk = fsImpl;
  const scope = new AsyncLocalStorage();
  const policy = policyFile ? readPolicy(policyFile, disk) : null;
  // A configured campaign never creates its own initial balance, even at boot.
  if (policy) readLedger(policy, disk);
  const isActive = () => scope.getStore() === policy && policy !== null;

  function syncDirectory(directory) {
    const fd = disk.openSync(directory, fs.constants.O_RDONLY);
    try { disk.fsyncSync(fd); } finally { disk.closeSync(fd); }
  }

  function reserve() {
    if (!policy.pricing.verified) throw denied('pricing_unverified');
    const now = clock();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now >= policy.expiresAtMs) throw denied('campaign_expired');
    const lockPath = `${policy.ledgerPath}.lock`;
    let lockFd;
    try { lockFd = disk.openSync(lockPath, 'wx', 0o600); } catch (_) { throw denied('ledger_busy'); }
    const directory = path.dirname(policy.ledgerPath);
    let tempFd;
    let durable = false;
    try {
      disk.fsyncSync(lockFd);
      const ledger = readLedger(policy, disk);
      if (ledger.usedMicros + policy.reservationMicros > policy.maxTotalMicros) {
        // No mutation occurred: a known exhausted ledger can safely unlock.
        durable = true;
        throw denied('budget_exhausted');
      }
      ledger.usedMicros += policy.reservationMicros;
      ledger.reservations.push({ sequence: ledger.reservations.length + 1,
        reservedMicros: policy.reservationMicros, atMs: now });
      const tempPath = `${policy.ledgerPath}.${randomUUID()}.tmp`;
      tempFd = disk.openSync(tempPath, 'wx', 0o600);
      disk.writeFileSync(tempFd, JSON.stringify(ledger));
      disk.fsyncSync(tempFd);
      disk.closeSync(tempFd);
      tempFd = undefined;
      disk.renameSync(tempPath, policy.ledgerPath);
      syncDirectory(directory);
      durable = true;
    } catch (error) {
      throw isAcceptanceSpendError(error) ? error : denied('ledger_unavailable');
    } finally {
      try { if (tempFd !== undefined) disk.closeSync(tempFd); } catch (_) { /* keep the lock */ }
      try { disk.closeSync(lockFd); } catch (_) { throw denied('ledger_unavailable'); }
      // A crash, corrupt ledger, or incomplete durable write leaves this lock
      // in place. Never steal a lock based on its age or its process id.
      if (durable) {
        try { disk.unlinkSync(lockPath); syncDirectory(directory); }
        catch (_) { throw denied('ledger_unavailable'); }
      }
    }
  }

  function withAcceptanceScope(identity, fn) {
    if (typeof fn !== 'function') throw new TypeError('Acceptance scope requires a callback');
    const matches = policy && identity?.userId === policy.userId && identity?.chatId === policy.chatId;
    if (isActive() && !matches) throw denied('operation_denied');
    return matches ? scope.run(policy, fn) : fn();
  }

  function bind(req, _res, next) {
    return withAcceptanceScope({ userId: req.user?.id, chatId: req.body?.chatId }, next);
  }

  function denyUnbudgetedOperation() {
    if (isActive()) throw denied('operation_denied');
  }

  function guardedFetch(fetchImpl) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Acceptance transport requires fetch');
    return async function acceptanceFetch(input, init) {
      if (!isActive()) return fetchImpl(input, init);
      // Snapshot before reservation; caller mutation cannot swap the body.
      const snapshot = plain(init) ? { ...init, redirect: 'error' } : init;
      validateRequest(input, snapshot);
      if (snapshot.signal?.aborted) throw denied('operation_cancelled');
      reserve();
      if (snapshot.signal?.aborted) throw denied('operation_cancelled');
      // There is deliberately no catch/refund, even if fetch never resolves.
      return fetchImpl(input, snapshot);
    };
  }

  function status() {
    if (!policy) return { configured: false, active: false };
    try {
      const ledger = readLedger(policy, disk);
      return { configured: true, active: isActive(), available: !disk.existsSync(`${policy.ledgerPath}.lock`)
        && policy.pricing.verified && integer(clock(), 0, policy.expiresAtMs - 1)
        && ledger.usedMicros + policy.reservationMicros <= policy.maxTotalMicros,
      maxTotalMicros: policy.maxTotalMicros, reservedMicros: ledger.usedMicros,
      reservations: ledger.reservations.length };
    } catch (_) { return { configured: true, active: isActive(), available: false }; }
  }

  return Object.freeze({ guardedFetch, withAcceptanceScope, middleware: Object.freeze({ bind }),
    isActive, denyUnbudgetedOperation, status });
}

const defaultGuard = createAcceptanceSpendGuard({
  policyFile: process.env.SIRAGPT_ACCEPTANCE_CAMPAIGN_FILE || '',
});

module.exports = { ...defaultGuard, createAcceptanceSpendGuard, isAcceptanceSpendError,
  ENDPOINT, MODEL, MAX_TOTAL_MICROS, ONE_USD_MICROS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS };
