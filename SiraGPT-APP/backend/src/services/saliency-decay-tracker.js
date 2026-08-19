'use strict';

/**
 * saliency-decay-tracker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks how attribution features rise and fall across a user's chat,
 * then reports which signals are "live", "fading", or "dead". Inspired by
 * the lifetime profile of transformer features in Anthropic's
 * attribution-graphs work (transformer-circuits.pub/2025/attribution-
 * graphs/biology.html): features have characteristic durations, and a
 * fact mentioned 20 turns ago is usually stale, while a constraint
 * reasserted 3 turns ago is still load-bearing. The chat orchestrator
 * was treating both equally; this module fixes that with an exponentially
 * decaying saliency score per feature, bumped on every re-activation.
 *
 * Public API:
 *   observe({ userId, chatId, turnIndex, features, now? })   → void
 *   classify({ userId, chatId, now? })                       → { live, fading, dead }
 *   topLive({ userId, chatId, k? })                          → Feature[]
 *   ageOut({ userId, chatId, now? })                         → number removed
 *   buildSaliencyBlock(classification, opts?)                → string
 *   stats() / clear() / __resetForTests()
 *
 * Tunables (env):
 *   SIRAGPT_SALIENCY_HALFLIFE_MS         (default 30 min)
 *   SIRAGPT_SALIENCY_LIVE_THRESHOLD      (default 0.50)
 *   SIRAGPT_SALIENCY_FADING_THRESHOLD    (default 0.15)
 *   SIRAGPT_SALIENCY_MAX_FEATURES        (default 64 per chat)
 *   SIRAGPT_SALIENCY_DEAD_AGE_MS         (default 6 hours)
 */

const HALF_LIFE_MS = Number(process.env.SIRAGPT_SALIENCY_HALFLIFE_MS) || 30 * 60 * 1000;
const LIVE_THRESHOLD = Number(process.env.SIRAGPT_SALIENCY_LIVE_THRESHOLD) || 0.50;
const FADING_THRESHOLD = Number(process.env.SIRAGPT_SALIENCY_FADING_THRESHOLD) || 0.15;
const MAX_FEATURES_PER_CHAT = Number(process.env.SIRAGPT_SALIENCY_MAX_FEATURES) || 64;
const DEAD_AGE_MS = Number(process.env.SIRAGPT_SALIENCY_DEAD_AGE_MS) || 6 * 60 * 60 * 1000;
// Hard cap on the number of tracked chats so the outer Map can't grow without
// bound over the process lifetime (ageOut() is never called in runtime). 5000 ≫
// concurrent active chats, so the LRU victim is always long-idle. Mirrors the
// FIFO/LRU cap already used in permission-manager.js / react-agent's caches.
const MAX_TRACKED_CHATS = Math.max(256, Number(process.env.SIRAGPT_SALIENCY_MAX_CHATS) || 5000);

const trackerState = new Map();

const keyFor = (userId, chatId) => `${userId || 'anon'}::${chatId || 'default'}`;

function featureKey(feature) {
  const kind = String(feature?.kind || feature?.category || 'unknown').toLowerCase();
  const label = String(feature?.label || feature?.value || feature?.text || '').toLowerCase().slice(0, 96);
  return `${kind}::${label}`;
}

const decay = (strength, ageMs) => (ageMs <= 0 ? strength : strength * Math.pow(0.5, ageMs / HALF_LIFE_MS));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function getOrCreateChat(userId, chatId) {
  const k = keyFor(userId, chatId);
  let map = trackerState.get(k);
  if (map) {
    // Refresh recency: re-insert so Map iteration order tracks LRU.
    trackerState.delete(k);
    trackerState.set(k, map);
    return map;
  }
  // Evict the least-recently-used chat before inserting a new one. The victim is
  // always long-idle (5000 ≫ active chats); at the 30-min half-life / 6h dead-age
  // its features would already be excluded from the live-only saliency block, so
  // the visible prompt/answer is unchanged. A re-touched chat just re-seeds.
  if (trackerState.size >= MAX_TRACKED_CHATS) {
    const oldest = trackerState.keys().next().value;
    if (oldest !== undefined) trackerState.delete(oldest);
  }
  map = new Map();
  trackerState.set(k, map);
  return map;
}

// Bump rule: a fresh activation moves prev 60 % toward saturation,
// then mixes in 30 % of the fresh feature's intrinsic weight.
function bumpStrength(prev, fresh) {
  const bumped = prev + (1 - prev) * 0.6;
  return clamp01(bumped * 0.7 + clamp01(fresh) * 0.3);
}

function observe({ userId, chatId, turnIndex = 0, features = [], now = Date.now() } = {}) {
  if (!Array.isArray(features) || features.length === 0) return;
  const chat = getOrCreateChat(userId, chatId);
  for (const [k, st] of chat) chat.set(k, { ...st, strength: decay(st.strength, now - st.lastSeenAt) });
  for (const f of features) {
    if (!f) continue;
    const k = featureKey(f);
    if (!k || k.endsWith('::')) continue;
    const fresh = clamp01(f.weight ?? f.confidence ?? 0.5);
    const prev = chat.get(k);
    if (prev) {
      chat.set(k, {
        ...prev,
        strength: bumpStrength(prev.strength, fresh),
        lastSeenAt: now,
        activationCount: prev.activationCount + 1,
        lastTurnIndex: turnIndex,
      });
    } else {
      chat.set(k, {
        kind: String(f.kind || f.category || 'unknown'),
        label: String(f.label || f.value || f.text || ''),
        strength: fresh,
        firstSeenAt: now,
        lastSeenAt: now,
        activationCount: 1,
        firstTurnIndex: turnIndex,
        lastTurnIndex: turnIndex,
      });
    }
  }
  if (chat.size > MAX_FEATURES_PER_CHAT) {
    const sorted = [...chat.entries()].sort((a, b) => b[1].strength - a[1].strength).slice(0, MAX_FEATURES_PER_CHAT);
    chat.clear();
    for (const [k, st] of sorted) chat.set(k, st);
  }
}

function classify({ userId, chatId, now = Date.now() } = {}) {
  const chat = trackerState.get(keyFor(userId, chatId));
  if (!chat || chat.size === 0) return { live: [], fading: [], dead: [] };
  const live = [];
  const fading = [];
  const dead = [];
  for (const st of chat.values()) {
    const ageMs = now - st.lastSeenAt;
    if (ageMs >= DEAD_AGE_MS) {
      dead.push({ ...st, currentSaliency: 0, ageMs });
      continue;
    }
    const currentSaliency = clamp01(decay(st.strength, ageMs));
    const row = {
      kind: st.kind, label: st.label,
      strength: Number(st.strength.toFixed(3)),
      currentSaliency: Number(currentSaliency.toFixed(3)),
      activationCount: st.activationCount,
      firstTurnIndex: st.firstTurnIndex,
      lastTurnIndex: st.lastTurnIndex,
      ageMs,
    };
    if (currentSaliency >= LIVE_THRESHOLD) live.push(row);
    else if (currentSaliency >= FADING_THRESHOLD) fading.push(row);
    else dead.push(row);
  }
  live.sort((a, b) => b.currentSaliency - a.currentSaliency);
  fading.sort((a, b) => b.currentSaliency - a.currentSaliency);
  dead.sort((a, b) => b.ageMs - a.ageMs);
  return { live, fading, dead };
}

const topLive = ({ userId, chatId, k = 5 } = {}) => classify({ userId, chatId }).live.slice(0, Math.max(0, k));

function ageOut({ userId, chatId, now = Date.now() } = {}) {
  const chat = trackerState.get(keyFor(userId, chatId));
  if (!chat) return 0;
  let removed = 0;
  for (const [k, st] of chat) {
    if (now - st.lastSeenAt >= DEAD_AGE_MS) { chat.delete(k); removed += 1; }
  }
  if (chat.size === 0) trackerState.delete(keyFor(userId, chatId));
  return removed;
}

function buildSaliencyBlock(classification, opts = {}) {
  if (!classification || !Array.isArray(classification.live) || classification.live.length === 0) return '';
  const maxLive = Number(opts.maxLive) || 6;
  const maxFading = Number(opts.maxFading) || 3;
  const lines = ['\n\n<saliency_state>'];
  lines.push('Señales activas en la conversación (alta saliencia primero).');
  lines.push('Trátalas como contexto vigente; ignora las "decayendo" salvo que sean relevantes.');
  lines.push('\nVivas:');
  for (const f of classification.live.slice(0, maxLive)) {
    lines.push(`  • [${f.kind}] ${f.label} (sal=${f.currentSaliency}, hits=${f.activationCount})`);
  }
  if (Array.isArray(classification.fading) && classification.fading.length > 0) {
    lines.push('Decayendo:');
    for (const f of classification.fading.slice(0, maxFading)) {
      lines.push(`  • [${f.kind}] ${f.label} (sal=${f.currentSaliency})`);
    }
  }
  lines.push('</saliency_state>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1200;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function stats() {
  let features = 0;
  for (const m of trackerState.values()) features += m.size;
  return { chats: trackerState.size, features };
}

function clear({ userId, chatId } = {}) {
  if (userId && chatId) { trackerState.delete(keyFor(userId, chatId)); return; }
  if (userId) {
    const prefix = `${userId}::`;
    for (const k of trackerState.keys()) if (k.startsWith(prefix)) trackerState.delete(k);
    return;
  }
  trackerState.clear();
}

const __resetForTests = () => trackerState.clear();

module.exports = {
  observe, classify, topLive, ageOut, buildSaliencyBlock, stats, clear,
  __resetForTests,
  HALF_LIFE_MS, LIVE_THRESHOLD, FADING_THRESHOLD, DEAD_AGE_MS, MAX_FEATURES_PER_CHAT,
};
