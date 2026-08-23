'use strict';

/**
 * runtime-overrides — kill-switch y overrides en runtime para feature flags.
 *
 * Problema que resuelve: hoy los flags operativos (CODEX_AGENT_V2,
 * DEPLOYMENTS_V2, FEATURE_DOC_ENGINE, NEXT_PUBLIC_AGENT_COMPUTER…) se
 * leen de process.env, que solo cambia con redeploy + restart del backend
 * — exactamente lo que hay que evitar durante un incidente.
 *
 * Mecánica: un super-admin escribe el override en SystemSettings
 * (key = 'runtime_flag_overrides', JSON). Los checks de flag consultan
 * wrapIsEnabled() ANTES del env; si hay override, gana. La lectura se
 * cachea en proceso FLAG_RUNTIME_TTL_MS (default 5s) y cada escritura
 * por API invalida la caché al instante en la réplica que escribe; las
 * demás réplicas convergen dentro del TTL (mismo modelo que
 * maintenance-mode).
 *
 * Fallos: si la DB no responde, se sirve la última instantánea conocida
 * (stale-while-error) y, si nunca hubo ninguna, se cae al env — el
 * sistema de flags nunca puede tumbar la API por sí mismo.
 *
 * Formato del valor almacenado:
 *   { "updatedAt": "...", "updatedBy": "user-id|null",
 *     "flags": { "CODEX_AGENT_V2": true, "FEATURE_DOC_ENGINE": false } }
 */

const KEY = 'runtime_flag_overrides';
const DEFAULT_TTL_MS = 5_000;

let _cache = null; // { value: {flags}, fetchedAt }
let _lastGood = { value: { flags: {} }, fetchedAt: 0 };
let _inflight = null;
let ttlMs = DEFAULT_TTL_MS;
let _prismaRef = null;

function setPrisma(prisma) {
  _prismaRef = prisma;
}

function setTtlMs(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) {
    ttlMs = Math.floor(n);
  }
}

function normalizeFlags(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [name, val] of Object.entries(input)) {
    const keyName = String(name || '').trim();
    if (!keyName || typeof val !== 'boolean') continue;
    out[keyName] = val;
  }
  return out;
}

function parseStoredValue(rowValue) {
  if (typeof rowValue !== 'string' || !rowValue) return null;
  try {
    const parsed = JSON.parse(rowValue);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      flags: normalizeFlags(parsed.flags),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
    };
  } catch (_err) {
    return null;
  }
}

async function readOverrides(prismaClient, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  if (!force && _cache && now - _cache.fetchedAt < ttlMs) {
    return _cache.value;
  }
  // Coalesce concurrent misses into one DB read.
  if (!_cache && _inflight && !force) return _inflight;

  const prisma = prismaClient || _prismaRef;
  const read = (async () => {
    try {
      let row = null;
      if (prisma && prisma.systemSettings && typeof prisma.systemSettings.findUnique === 'function') {
        row = await prisma.systemSettings.findUnique({ where: { key: KEY } });
      }
      const parsed = parseStoredValue(row ? row.value : null);
      _lastGood = {
        value: {
          flags: parsed ? parsed.flags : {},
          updatedAt: parsed ? parsed.updatedAt : null,
          updatedBy: parsed ? parsed.updatedBy : null,
        },
        fetchedAt: Date.now(),
      };
      return _lastGood.value;
    } catch (err) {
      console.warn('[runtime-overrides] read failed; serving last-known state:', err?.message || err);
      return _lastGood.value;
    } finally {
      _inflight = null;
    }
  })();

  if (force) {
    const v = await read;
    _cache = { value: v, fetchedAt: Date.now() };
    return v;
  }
  _inflight = read;
  try {
    const v = await read;
    _cache = { value: v, fetchedAt: Date.now() };
    return v;
  } catch (_err) {
    // read() never rejects, but stay safe.
    return _lastGood.value;
  }
}

function invalidateRuntimeCache() {
  _cache = null;
  _inflight = null;
}

/**
 * Override activo para un flag, o undefined si no hay.
 * Sincrónico a propósito: consulta solo la caché en proceso; la carga
 * desde DB ocurre vía readOverrides() (llamado por el middleware de
 * calentamiento y tras invalidaciones). Así los call sites de flags
 * no necesitan volverse async.
 */
function getOverrideSync(name) {
  if (!_cache) return undefined;
  const flags = _cache.value.flags || {};
  const v = flags[String(name || '').trim()];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Envuelve un check de flag existente (p. ej. isCodexV2Enabled):
 *   module.exports.isCodexV2Enabled = wrapIsEnabled('CODEX_AGENT_V2', isCodexV2Enabled)
 * El override runtime (DB) gana sobre el resultado base (env).
 */
function wrapIsEnabled(flagName, baseCheckFn) {
  const name = String(flagName || '').trim();
  return function wrapped(env = process.env) {
    const override = getOverrideSync(name);
    if (typeof override === 'boolean') return override;
    return baseCheckFn(env);
  };
}

async function writeOverrides(prismaClient, { flags, actorId, message, remove }) {
  const prisma = prismaClient || _prismaRef;
  if (!prisma || !prisma.systemSettings || typeof prisma.systemSettings.upsert !== 'function') {
    throw new Error('SystemSettings model unavailable');
  }
  const clean = normalizeFlags(flags);
  const removals = Array.isArray(remove)
    ? remove.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  let current = { flags: {}, updatedAt: null, updatedBy: null };
  try {
    const row = await prisma.systemSettings.findUnique({ where: { key: KEY } });
    const parsed = parseStoredValue(row ? row.value : null);
    if (parsed) current = parsed;
  } catch (_err) {
    // merge over empty state on read failure
  }
  const merged = { ...current.flags, ...clean };
  for (const name of removals) delete merged[name];
  const next = {
    flags: merged,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId != null ? String(actorId) : null,
    message: typeof message === 'string' && message ? String(message).slice(0, 300) : null,
  };
  const value = JSON.stringify(next);
  await prisma.systemSettings.upsert({
    where: { key: KEY },
    create: { key: KEY, value },
    update: { value },
  });
  invalidateRuntimeCache();
  await readOverrides(prisma, { force: true });
  return next;
}

module.exports = {
  KEY,
  DEFAULT_TTL_MS,
  setPrisma,
  setTtlMs,
  readOverrides,
  writeOverrides,
  getOverrideSync,
  wrapIsEnabled,
  invalidateRuntimeCache,
  // Exposed for tests
  _internal: { parseStoredValue, normalizeFlags },
};
