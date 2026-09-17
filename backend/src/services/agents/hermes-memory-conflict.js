'use strict';

/**
 * Hermes USER/MEMORY fact conflict resolution.
 *
 * Native rewrite of the Hermes MEMORY.md vs USER.md *idea* (profile facts
 * vs agent notes, keep one value per topic). Not a dump of NousResearch/hermes-agent
 * — no Python memory_tool, no OpenRouter, no paid LLM on this path.
 *
 * Rules (deterministic, bilingual ES/EN):
 *   1. Pinned USER profile wins, even if a MEMORY (or unpinned USER) fact
 *      is newer.
 *   2. Otherwise the newer timestamp wins.
 *   3. Two pinned USER facts that disagree are reported, not deleted.
 *   4. The merge report is Spanish, brand_label = SiraGPT, no vendor ids.
 *
 * Isolation: every read/write is keyed by userId.
 */

const biblioteca = require('./hermes-biblioteca');

const BRAND_LABEL = 'SiraGPT';
const KIND = 'sira.hermes-memory-merge';
const SCHEMA_VERSION = 1;

const ALIAS_TO_KEY = Object.freeze({
  timezone: 'timezone',
  tz: 'timezone',
  zona_horaria: 'timezone',
  zona: 'timezone',
  name: 'name',
  nombre: 'name',
  language: 'language',
  idioma: 'language',
  lengua: 'language',
  theme: 'theme',
  tema: 'theme',
  editor: 'editor',
  shell: 'shell',
  os: 'os',
  sistema: 'os',
  communication: 'communication',
  comunicacion: 'communication',
  estilo: 'communication',
  prefers_lang: 'prefers_lang',
  lenguaje: 'prefers_lang',
  role: 'role',
  rol: 'role',
});

const LANG_VALUES = Object.freeze({
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  rust: 'rust',
  golang: 'go',
  go: 'go',
  java: 'java',
  ruby: 'ruby',
});

const THEME_VALUES = Object.freeze({
  dark: 'dark',
  oscuro: 'dark',
  light: 'light',
  claro: 'light',
});

const COMM_VALUES = Object.freeze({
  corta: 'short',
  cortas: 'short',
  corto: 'short',
  conciso: 'short',
  concise: 'short',
  short: 'short',
  detallada: 'detailed',
  detalladas: 'detailed',
  detallado: 'detailed',
  verbose: 'detailed',
  detailed: 'detailed',
  larga: 'detailed',
  largas: 'detailed',
});

const UI_LANG_VALUES = Object.freeze({
  espanol: 'es',
  spanish: 'es',
  es: 'es',
  ingles: 'en',
  english: 'en',
  en: 'en',
});

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function nowMs(opts = {}) {
  const n = Number(opts.now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function fail(code, error, extra = {}) {
  const { status, ...rest } = extra;
  return {
    ok: false,
    success: false,
    code,
    error,
    status: status || 400,
    message: error,
    ...rest,
  };
}

function spanishMessage(code, params = {}) {
  const key = params.key || '';
  const text = params.text || params.a || '';
  const needle = params.needle || '';
  const map = {
    missing_user: 'Falta el userId para fusionar memoria.',
    foreign_owner: 'No puedes fusionar la memoria de otro usuario.',
    pin_user_only: 'Solo se puede fijar un dato del perfil (USER).',
    pin_not_found: `Ningún dato del perfil coincidió con '${needle}'.`,
    pin_ambiguous: `Varios datos del perfil coincidieron con '${needle}'. Sé más específico.`,
    pinned_ok: text ? `Perfil fijado: ${text}` : 'Perfil fijado.',
    unpinned_ok: text ? `Se quitó el ancla del perfil: ${text}` : 'Se quitó el ancla del perfil.',
    already_pinned: 'Ese dato del perfil ya estaba fijado.',
    already_unpinned: 'Ese dato del perfil no estaba fijado.',
    no_conflicts: 'No hay conflictos entre USER y MEMORY.',
    dry_run: 'Simulación: no se modificó la memoria.',
    resolved_pinned: key
      ? `Se conservó el perfil fijado (${key}) frente a un dato más reciente.`
      : 'Se conservó el perfil fijado frente a un dato más reciente.',
    resolved_newer: key
      ? `Se conservó el dato más reciente (${key}).`
      : 'Se conservó el dato más reciente.',
    skipped_pinned: key
      ? `Se omitió retirar un perfil fijado en conflicto (${key}).`
      : 'Se omitió retirar un perfil fijado en conflicto.',
    report_title: 'Informe de fusión de memoria',
  };
  return map[code] || `aviso de memoria: ${code}`;
}

function normalizeFactText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match ? String(match[1] || match[0]).trim() : '';
}

function canonicalKey(raw) {
  const key = normalizeFactText(raw).replace(/[\s-]+/g, '_');
  return ALIAS_TO_KEY[key] || (ALIAS_TO_KEY[key] === undefined && /^[a-z][a-z0-9_]{1,31}$/.test(key) ? key : null);
}

function pickMapped(token, table) {
  const norm = normalizeFactText(token).replace(/[^a-z0-9/+_-]/g, '');
  return table[norm] || null;
}

function extractExplicitSlot(norm) {
  const match = norm.match(/^([a-z_][a-z0-9_]{1,31})\s*[:=]\s*(.+)$/);
  if (!match) return null;
  const key = canonicalKey(match[1]);
  const value = normalizeFactText(match[2]);
  if (!key || !value) return null;
  return { key, value };
}

function extractSlots(text) {
  const raw = String(text || '').trim();
  const norm = normalizeFactText(raw);
  if (!norm) return [];
  const slots = [];
  const seen = new Set();

  const push = (key, value) => {
    const k = String(key || '').trim();
    const v = normalizeFactText(value).replace(/[.,;:!?]+$/g, '');
    if (!k || !v) return;
    const id = `${k}::${v}`;
    if (seen.has(id)) return;
    seen.add(id);
    slots.push({ key: k, value: v });
  };

  const explicit = extractExplicitSlot(norm);
  if (explicit) push(explicit.key, explicit.value);

  const tz = firstMatch(norm, /\b(?:zona horaria|timezone|time zone|\btz)\b(?:\s*(?:es|is|:|=))?\s*([a-z0-9_+\-\/.]+)/);
  if (tz) push('timezone', tz);

  const name = firstMatch(norm, /\b(?:mi nombre(?: es)?|my name is|me llamo)\s+([a-z][a-z0-9._-]{1,40})/);
  if (name) push('name', name);

  const uiLangCue = firstMatch(norm, /\b(?:respuestas en|responde en|idioma|language)\s+(?:es\s+|is\s+)?([a-z]+)/);
  if (uiLangCue) push('language', pickMapped(uiLangCue, UI_LANG_VALUES) || uiLangCue);

  if (/\b(dark mode|modo oscuro|tema oscuro)\b/.test(norm)) push('theme', 'dark');
  if (/\b(light mode|modo claro|tema claro)\b/.test(norm)) push('theme', 'light');
  const themeWord = firstMatch(norm, /\b(?:tema|theme)\s+(?:es\s+|is\s+)?([a-z]+)/);
  if (themeWord) {
    const mapped = pickMapped(themeWord, THEME_VALUES);
    if (mapped) push('theme', mapped);
  }

  const editor = firstMatch(norm, /\b(?:editor)\s*(?:es|is|:|=)?\s*(vscode|vs code|vim|neovim|emacs|sublime)/)
    || firstMatch(norm, /\b(vscode|vs code|neovim|emacs|sublime|\bvim\b)\b/);
  if (editor && /\b(editor|vscode|vim|neovim|emacs|sublime)\b/.test(norm)) {
    push('editor', editor.replace(/\s+/g, ''));
  }

  const shell = firstMatch(norm, /\b(?:shell)\s*(?:es|is|:|=)?\s*(zsh|bash|fish|powershell)/)
    || firstMatch(norm, /\b(zsh|bash|fish|powershell)\b/);
  if (shell && /\b(shell|zsh|bash|fish|powershell)\b/.test(norm)) push('shell', shell);

  const os = firstMatch(norm, /\b(macos|mac os|ubuntu|debian|windows|linux)\b/);
  if (os && /\b(os|sistema|macos|ubuntu|debian|windows|linux)\b/.test(norm)) {
    push('os', os.replace(/\s+/g, ''));
  }

  const prefLang = firstMatch(
    norm,
    /\b(?:prefier\w+|i prefer|user prefers|me gusta)\s+(?:el\s+|la\s+|los\s+|un\s+|una\s+)?(typescript|javascript|python|golang|rust|java|ruby|go)\b/,
  );
  if (prefLang) push('prefers_lang', pickMapped(prefLang, LANG_VALUES) || prefLang);

  if (/\b(respuestas?|comunicacion|communication|concis|verbose|detallad)\b/.test(norm)) {
    for (const [token, value] of Object.entries(COMM_VALUES)) {
      if (new RegExp(`\\b${token}\\b`).test(norm)) push('communication', value);
    }
  }

  const role = firstMatch(norm, /\b(?:rol|role)\s*(?:es|is|:|=)?\s*([a-z][a-z0-9_-]{1,40})/);
  if (role) push('role', role);

  return slots;
}

function enrichFact(fact) {
  const text = String(fact?.text || fact?.content || '').trim();
  const slots = Array.isArray(fact?.slots) && fact.slots.length
    ? fact.slots
    : extractSlots(text);
  return {
    store: fact?.store === 'user' ? 'user' : 'memory',
    text,
    pinned: fact?.pinned === true && fact?.store === 'user',
    createdAt: Number(fact?.createdAt) || 0,
    updatedAt: Number(fact?.updatedAt) || Number(fact?.createdAt) || 0,
    slots,
  };
}

function factId(fact) {
  return `${fact.store}::${fact.text}`;
}

function compareRecency(a, b) {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.store !== b.store) return a.store === 'user' ? -1 : 1;
  return String(a.text).localeCompare(String(b.text));
}

function pickWinner(facts) {
  const rows = (Array.isArray(facts) ? facts : []).map(enrichFact).filter((row) => row.text);
  if (!rows.length) return null;
  const pinned = rows.filter((row) => row.pinned);
  if (pinned.length) {
    return [...pinned].sort(compareRecency)[0];
  }
  return [...rows].sort(compareRecency)[0];
}

function detectConflicts(facts) {
  const rows = (Array.isArray(facts) ? facts : []).map(enrichFact).filter((row) => row.text);
  const byKey = new Map();
  for (const fact of rows) {
    for (const slot of fact.slots) {
      if (!byKey.has(slot.key)) byKey.set(slot.key, []);
      byKey.get(slot.key).push({ fact, value: slot.value });
    }
  }

  const groups = [];
  for (const [key, members] of byKey.entries()) {
    const values = [...new Set(members.map((row) => row.value))];
    if (values.length < 2) continue;
    const uniqueFacts = [];
    const seen = new Set();
    for (const row of members) {
      const id = factId(row.fact);
      if (seen.has(id)) continue;
      seen.add(id);
      uniqueFacts.push(row.fact);
    }
    if (uniqueFacts.length < 2) continue;
    groups.push({
      key,
      values,
      facts: uniqueFacts,
    });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

function resolveGroup(group) {
  const facts = (group.facts || []).map(enrichFact);
  const winner = pickWinner(facts);
  if (!winner) {
    return { key: group.key, rule: 'none', winner: null, remove: [], skipped: [] };
  }
  const pinnedLosers = facts.filter((row) => row.pinned && factId(row) !== factId(winner));
  const remove = facts.filter((row) => factId(row) !== factId(winner) && !row.pinned);
  const rule = winner.pinned ? 'perfil_fijado' : 'mas_reciente';
  return {
    key: group.key,
    values: group.values || [...new Set(facts.flatMap((row) => row.slots.filter((s) => s.key === group.key).map((s) => s.value)))],
    rule,
    winner,
    remove,
    skipped: pinnedLosers,
    message: spanishMessage(rule === 'perfil_fijado' ? 'resolved_pinned' : 'resolved_newer', { key: group.key }),
  };
}

function collectRemovals(decisions) {
  const protectedIds = new Set();
  for (const decision of decisions) {
    if (decision.winner && decision.winner.pinned) protectedIds.add(factId(decision.winner));
    for (const skipped of decision.skipped || []) protectedIds.add(factId(skipped));
  }
  const removals = [];
  const seen = new Set();
  for (const decision of decisions) {
    for (const fact of decision.remove || []) {
      const id = factId(fact);
      if (protectedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      removals.push(fact);
    }
  }
  return removals;
}

function renderMergeReport({ userId, decisions, removals, dryRun, now } = {}) {
  const lines = [
    `# ${spanishMessage('report_title')}`,
    '',
    `kind: ${KIND}`,
    `marca: ${BRAND_LABEL}`,
    `usuario: ${userId || ''}`,
    `cuando: ${Number(now) || 0}`,
    `conflictos: ${(decisions || []).length}`,
    `retirados: ${(removals || []).length}`,
    `simulacion: ${dryRun ? 'si' : 'no'}`,
    '',
  ];
  if (!(decisions || []).length) {
    lines.push(spanishMessage('no_conflicts'), '');
    return lines.join('\n');
  }
  for (const decision of decisions) {
    lines.push(`## Conflicto: ${decision.key}`);
    lines.push(`regla: ${decision.rule}`);
    lines.push(`mensaje: ${decision.message}`);
    if (decision.winner) {
      const pin = decision.winner.pinned ? ', fijado' : '';
      lines.push(`conservar: ${decision.winner.text} (${decision.winner.store}${pin})`);
    }
    for (const fact of decision.remove || []) {
      lines.push(`retirar: ${fact.text} (${fact.store})`);
    }
    for (const fact of decision.skipped || []) {
      lines.push(`omitido_fijado: ${fact.text} (${fact.store})`);
    }
    lines.push('');
  }
  lines.push('Adaptado del patrón MEMORY.md / USER.md de Hermes Agent (MIT). Sin código upstream.');
  lines.push('');
  return lines.join('\n');
}

function resolveCallerUserId(userId, opts = {}) {
  const session = normalizeUserId(opts.sessionUserId);
  const requested = normalizeUserId(userId);
  if (session && requested && session !== requested) {
    return fail('E_PARAMS', spanishMessage('foreign_owner'));
  }
  const id = session || requested;
  if (!id) return fail('E_PARAMS', spanishMessage('missing_user'));
  return { ok: true, userId: id };
}

function curatedMemory() {
  return require('./hermes-curated-memory');
}

function resolveConflicts(userId, opts = {}) {
  const resolved = resolveCallerUserId(userId, opts);
  if (!resolved.ok) return resolved;

  const curated = opts.curated || curatedMemory();
  const facts = (Array.isArray(opts.facts) ? opts.facts : curated.listFacts(resolved.userId)).map(enrichFact);
  const groups = detectConflicts(facts);
  const decisions = groups.map(resolveGroup);
  const removals = collectRemovals(decisions);
  const dryRun = opts.dryRun === true;
  const report = renderMergeReport({
    userId: resolved.userId,
    decisions,
    removals,
    dryRun,
    now: nowMs(opts),
  });

  const kept = decisions.map((row) => row.winner).filter(Boolean);
  const skippedPinned = decisions.reduce((n, row) => n + (row.skipped || []).length, 0);
  const message = !decisions.length
    ? spanishMessage('no_conflicts')
    : dryRun
      ? spanishMessage('dry_run')
      : decisions.some((row) => row.rule === 'perfil_fijado')
        ? spanishMessage('resolved_pinned', { key: decisions.find((row) => row.rule === 'perfil_fijado').key })
        : spanishMessage('resolved_newer', { key: decisions[0].key });

  const payload = {
    ok: true,
    success: true,
    kind: KIND,
    version: SCHEMA_VERSION,
    brand_label: BRAND_LABEL,
    userId: resolved.userId,
    dryRun,
    conflicts: decisions.length,
    removed: dryRun ? 0 : removals.length,
    pendingRemovals: removals.length,
    kept: kept.length,
    skippedPinned,
    decisions,
    removals: dryRun ? [] : removals,
    report,
    message,
  };

  if (!decisions.length || dryRun) return payload;

  if (typeof curated.dropFacts === 'function' && removals.length) {
    curated.dropFacts(resolved.userId, removals);
  }

  let deposited = null;
  if (opts.deposit !== false) {
    deposited = biblioteca.deposit({
      userId: resolved.userId,
      chatId: opts.chatId || null,
      title: 'memoria-fusion',
      body: report,
      kind: 'plan',
      save: opts.save,
    });
  }

  return {
    ...payload,
    removed: removals.length,
    removals,
    biblioteca: deposited,
    asset_id: deposited && deposited.ok ? deposited.asset_id : null,
  };
}

function status() {
  return {
    pattern: 'hermes-memory-conflict',
    kind: KIND,
    version: SCHEMA_VERSION,
    brand_label: BRAND_LABEL,
    rules: ['perfil_fijado', 'mas_reciente'],
    stores: ['user', 'memory'],
  };
}

module.exports = {
  BRAND_LABEL,
  KIND,
  SCHEMA_VERSION,
  spanishMessage,
  normalizeFactText,
  extractSlots,
  enrichFact,
  detectConflicts,
  pickWinner,
  resolveGroup,
  collectRemovals,
  renderMergeReport,
  resolveCallerUserId,
  resolveConflicts,
  status,
};
