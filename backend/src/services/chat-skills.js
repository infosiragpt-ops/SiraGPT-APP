'use strict';

/**
 * chat-skills — Agent Skills for the /agentes chat, claude.ai style.
 *
 * A skill is a named playbook (SKILL.md: name + description + markdown body).
 * Two sources, merged into one catalog:
 *
 *   1. Built-in document skills shipped with the platform
 *      (services/sandbox/skills/*.md — Word, PowerPoint, Excel, PDF, CSV).
 *   2. The user's own skills saved in their Biblioteca (skills-persist,
 *      one SKILL.md per skill, user-scoped).
 *
 * Two ways a skill reaches a turn, like Claude:
 *   - Explicit: the user picks it in the composer «+ → Skills»; the chosen
 *     skills travel as `skills: [name]` on /api/ai/generate and their bodies
 *     are injected as a load-bearing system block for that turn.
 *   - Automatic: the agent loop exposes `use_skill` (agent-harness); the model
 *     sees the catalog (names + one-line descriptions) and loads a body only
 *     when the task calls for it (progressive disclosure — the context stays
 *     lean until the specialised knowledge is needed).
 *
 * Pure Node, no network, never throws to callers (best-effort loaders).
 */

const fs = require('fs');
const path = require('path');

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SELECTED_SKILLS = 3;
const MAX_SKILL_PROMPT_CHARS = 8000;
const MAX_TOTAL_PROMPT_CHARS = 16000;
const MAX_USER_SKILLS = 40;
const MAX_DESCRIPTION_CHARS = 160;

const BUILTIN_DIR = path.join(__dirname, 'sandbox', 'skills');
const BUILTIN_CATEGORY = 'Archivos y documentos';
const SKILLS_AUTHOR = 'SiraGPT';

function catalogStore() {
  try {
    // eslint-disable-next-line global-require
    return require('./skills-catalog');
  } catch {
    return null;
  }
}

const BUILTIN_SKILLS = Object.freeze([
  {
    name: 'docx',
    title: 'Word',
    description: 'Crear y editar documentos Word (.docx) con formato profesional, sin romper el original.',
    file: 'docx.md',
  },
  {
    name: 'pptx',
    title: 'PowerPoint',
    description: 'Presentaciones .pptx con diseño profesional y edición quirúrgica de diapositivas.',
    file: 'pptx.md',
  },
  {
    name: 'xlsx',
    title: 'Excel',
    description: 'Hojas de cálculo .xlsx: fórmulas, formato y edición de celdas sin reescribir el libro.',
    file: 'xlsx.md',
  },
  {
    name: 'pdf',
    title: 'PDF',
    description: 'Leer, crear, combinar y editar archivos PDF.',
    file: 'pdf.md',
  },
  {
    name: 'csv',
    title: 'CSV',
    description: 'Limpiar, transformar y analizar datos tabulares en CSV.',
    file: 'csv.md',
  },
]);

const BUILTIN_BY_NAME = new Map(BUILTIN_SKILLS.map((s) => [s.name, s]));

function normalizeSkillName(value) {
  const clean = String(value == null ? '' : value).trim().toLowerCase().replace(/^\//, '');
  return SKILL_NAME_RE.test(clean) ? clean : null;
}

/** Parse `---\nname: x\ndescription: y\n---\nbody` (frontmatter optional). */
function parseSkillMarkdown(raw, fallbackName = '') {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const name = normalizeSkillName(meta.name) || normalizeSkillName(fallbackName);
  if (!name) return null;
  let description = String(meta.description || '').trim();
  if (!description) {
    const firstLine = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    description = firstLine;
  }
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    body: body.trim(),
  };
}

function readBuiltinBody(skill, { dir = BUILTIN_DIR } = {}) {
  try {
    return fs.readFileSync(path.join(dir, skill.file), 'utf8').trim();
  } catch {
    return '';
  }
}

function persistStore(persist) {
  if (persist) return persist;
  try {
    // eslint-disable-next-line global-require
    return require('./skills-persist');
  } catch {
    return null;
  }
}

function listUserSkills({ userId, persist = null, root = undefined } = {}) {
  const uid = String(userId || '').trim();
  const store = persistStore(persist);
  if (!uid || !store) return [];
  let listed = [];
  try {
    listed = store.listPersistedSkills(root ? { userId: uid, root } : { userId: uid }) || [];
  } catch {
    return [];
  }
  const out = [];
  for (const item of listed.slice(0, MAX_USER_SKILLS)) {
    if (BUILTIN_BY_NAME.has(item && item.name)) continue;
    try {
      const loaded = store.loadPersistedSkill(root ? { userId: uid, name: item.name, root } : { userId: uid, name: item.name });
      if (!loaded || !loaded.ok) continue;
      const parsed = parseSkillMarkdown(loaded.body, item.name);
      if (!parsed || BUILTIN_BY_NAME.has(parsed.name)) continue;
      out.push({ ...parsed, title: parsed.name, source: 'biblioteca', updatedAt: item.updatedAt || null });
    } catch {
      /* one unreadable skill never hides the others */
    }
  }
  return out;
}

/**
 * Effective per-user state: installed catalog skills (defaults included
 * unless the user removed them) and the switched-off set. Never throws.
 */
function getSkillState({ userId = null, persist = null, root = undefined } = {}) {
  const uid = String(userId || '').trim();
  const store = persistStore(persist);
  let raw = { installed: {}, disabled: [], removed: [] };
  if (uid && store && typeof store.readSkillState === 'function') {
    try { raw = store.readSkillState(root ? { userId: uid, root } : { userId: uid }) || raw; } catch { /* defaults */ }
  }
  const catalogMod = catalogStore();
  const installed = new Map(Object.entries(raw.installed || {}));
  const removed = new Set(raw.removed || []);
  for (const name of (catalogMod && catalogMod.DEFAULT_INSTALLED) || []) {
    if (!removed.has(name) && !installed.has(name)) installed.set(name, null);
  }
  for (const name of [...installed.keys()]) {
    if (!catalogMod || !catalogMod.isCatalogSkill(name)) installed.delete(name);
  }
  return { installed, disabled: new Set(raw.disabled || []), removed, raw };
}

function saveSkillState({ userId, state, persist = null, root = undefined }) {
  const store = persistStore(persist);
  if (!store || typeof store.writeSkillState !== 'function') {
    throw Object.assign(new Error('Las skills no están disponibles ahora.'), { status: 503 });
  }
  return store.writeSkillState(root ? { userId, state, root } : { userId, state });
}

function installedCatalogSkills(state) {
  const catalogMod = catalogStore();
  if (!catalogMod) return [];
  const out = [];
  for (const [name, installedAt] of state.installed.entries()) {
    const meta = catalogMod.getCatalogSkill(name);
    if (!meta) continue;
    out.push({
      name: meta.name,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      source: 'catalog',
      updatedAt: installedAt || (meta.added ? new Date(meta.added).toISOString() : null),
    });
  }
  return out;
}

/**
 * Catalog for the picker («+ → Skills», «/») and the agent: built-ins, the
 * user's own skills and the catalog skills they installed. Switched-off
 * skills are left out unless `includeDisabled` (Ajustes → Skills needs them).
 */
function listChatSkills({ userId = null, persist = null, root = undefined, includeDisabled = false } = {}) {
  const state = getSkillState({ userId, persist, root });
  const keep = (name) => includeDisabled || !state.disabled.has(name);
  const builtins = BUILTIN_SKILLS.filter((s) => keep(s.name)).map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
    category: BUILTIN_CATEGORY,
    source: 'builtin',
  }));
  const seen = new Set(BUILTIN_SKILLS.map((s) => s.name));
  const user = [];
  for (const s of listUserSkills({ userId, persist, root })) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    if (!keep(s.name)) continue;
    user.push({ name: s.name, title: s.title, description: s.description, category: 'Creado por ti', source: s.source });
  }
  const catalog = [];
  for (const s of installedCatalogSkills(state)) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    if (!keep(s.name)) continue;
    catalog.push({ name: s.name, title: s.title, description: s.description, category: s.category, source: 'catalog' });
  }
  return builtins.concat(user, catalog);
}

/** One skill with its body, or null. Built-ins win over a same-named user skill. */
function loadChatSkill({ userId = null, name, persist = null, root = undefined, builtinDir = BUILTIN_DIR, respectDisabled = false } = {}) {
  const clean = normalizeSkillName(name);
  if (!clean) return null;
  if (respectDisabled && getSkillState({ userId, persist, root }).disabled.has(clean)) return null;
  const builtin = BUILTIN_BY_NAME.get(clean);
  if (builtin) {
    const body = readBuiltinBody(builtin, { dir: builtinDir });
    if (!body) return null;
    return { name: builtin.name, title: builtin.title, description: builtin.description, source: 'builtin', body };
  }
  const uid = String(userId || '').trim();
  const store = persistStore(persist);
  if (uid && store) {
    try {
      const loaded = store.loadPersistedSkill(root ? { userId: uid, name: clean, root } : { userId: uid, name: clean });
      if (loaded && loaded.ok) {
        const parsed = parseSkillMarkdown(loaded.body, clean);
        if (parsed && parsed.body) return { ...parsed, title: parsed.name, source: 'biblioteca' };
      }
    } catch {
      /* fall through to the catalog */
    }
  }
  // Catalog skills resolve for everyone: installed ones, and «Probar» trials.
  const catalogMod = catalogStore();
  const meta = catalogMod && catalogMod.getCatalogSkill(clean);
  if (!meta) return null;
  return { name: meta.name, title: meta.title, description: meta.description, category: meta.category, source: 'catalog', body: meta.body };
}

/** Validated, de-duplicated, capped names from an untrusted request body. */
function normalizeSelectedSkillNames(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
  const out = [];
  for (const item of list) {
    const value = item && typeof item === 'object' ? item.name : item;
    const clean = normalizeSkillName(value);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_SELECTED_SKILLS) break;
  }
  return out;
}

function resolveSelectedSkills({ userId = null, names = [], persist = null, root = undefined, builtinDir = BUILTIN_DIR } = {}) {
  const loaded = [];
  const missing = [];
  for (const name of normalizeSelectedSkillNames(names)) {
    const skill = loadChatSkill({ userId, name, persist, root, builtinDir });
    if (skill) loaded.push(skill);
    else missing.push(name);
  }
  return { skills: loaded, missing };
}

function clip(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}\n[… skill recortada: ${value.length - max} caracteres omitidos]`;
}

/** Load-bearing system block for the skills the user activated this turn. */
function buildSelectedSkillsBlock(skills = []) {
  const list = (Array.isArray(skills) ? skills : []).filter((s) => s && s.body);
  if (!list.length) return '';
  let budget = MAX_TOTAL_PROMPT_CHARS;
  const sections = [];
  for (const skill of list) {
    if (budget <= 200) break;
    const body = clip(skill.body, Math.min(MAX_SKILL_PROMPT_CHARS, budget));
    budget -= body.length;
    const label = skill.title && skill.title !== skill.name ? `${skill.title} (${skill.name})` : skill.name;
    sections.push(`### Skill: ${label}\n${body}`);
  }
  if (!sections.length) return '';
  return [
    '',
    '',
    '## Skills activas en este turno',
    'El usuario activó estas skills para su mensaje. Sigue sus instrucciones como procedimiento de trabajo prioritario en esta respuesta: por encima de tu estilo por defecto, nunca por encima de la seguridad ni de lo que el usuario pida de forma explícita en su mensaje. No las menciones salvo que el usuario pregunte.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * Append the user's picked skills to an agent system prompt (agent-task
 * runner / inline task loop). Never throws; returns the prompt unchanged
 * when nothing was picked or nothing resolves.
 */
function selectedSkillsSuffix({ userId = null, names = [] } = {}) {
  try {
    const clean = normalizeSelectedSkillNames(names);
    if (!clean.length) return '';
    const { skills } = resolveSelectedSkills({ userId, names: clean });
    return buildSelectedSkillsBlock(skills);
  } catch {
    return '';
  }
}

/** One line per skill — what the agent sees before loading a body. */
function formatSkillsCatalog(catalog = []) {
  return (Array.isArray(catalog) ? catalog : [])
    .map((s) => `- ${s.name}${s.source === 'biblioteca' ? ' (de tu Biblioteca)' : ''}: ${s.description}`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// Ajustes → Skills (claude.ai): «Tuyos», «Descubrir» and management
// ─────────────────────────────────────────────────────────────

function skillError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function reservedSkillName(name) {
  const catalogMod = catalogStore();
  return BUILTIN_BY_NAME.has(name) || Boolean(catalogMod && catalogMod.isCatalogSkill(name));
}

/** «Tuyos»: what the user created, and what ships from SiraGPT (built-ins + installed catalog). */
function listSkillLibrary({ userId = null, persist = null, root = undefined } = {}) {
  const state = getSkillState({ userId, persist, root });
  // listUserSkills already drops built-in names; an own skill that shares a
  // catalog name (older Biblioteca skills) stays visible and editable, and
  // hides the catalog entry it shadows (the agent uses the own one).
  const ownSkills = listUserSkills({ userId, persist, root });
  const ownNames = new Set(ownSkills.map((s) => s.name));
  const mine = ownSkills
    .map((s) => ({
      name: s.name,
      title: s.title,
      description: s.description,
      category: 'Creado por ti',
      source: 'biblioteca',
      author: 'por ti',
      enabled: !state.disabled.has(s.name),
      updatedAt: s.updatedAt || null,
      editable: true,
      removable: true,
    }));
  const partners = BUILTIN_SKILLS.map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
    category: BUILTIN_CATEGORY,
    source: 'builtin',
    author: SKILLS_AUTHOR,
    enabled: !state.disabled.has(s.name),
    updatedAt: null,
    editable: false,
    removable: false,
  })).concat(installedCatalogSkills(state).filter((s) => !ownNames.has(s.name)).map((s) => ({
    ...s,
    author: SKILLS_AUTHOR,
    enabled: !state.disabled.has(s.name),
    editable: false,
    removable: true,
  })));
  return { mine, partners };
}

const STOPWORDS = new Set(('de la el los las un una y o en para por con sin que del al se su sus es mi mis tu tus '
  + 'como más muy lo le les ya pero sobre entre cuando donde este esta esto the and for with you your').split(' '));

function keywordSet(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

/**
 * «Para ti»: catalog skills ranked by overlap with what SiraGPT remembers
 * about the user (memory + profile text passed in by the route). With no
 * signal it falls back to the newest skills, never a random pick.
 */
function rankForUser(items, memoryText, limit = 6) {
  const words = keywordSet(memoryText);
  const scored = items.map((s, index) => {
    let score = 0;
    if (words.size) {
      const hay = keywordSet(`${s.name.replace(/-/g, ' ')} ${s.title} ${s.description} ${s.category}`);
      for (const w of hay) if (words.has(w)) score += 1;
    }
    return { s, score, index };
  });
  const byDate = (a, b) => String(b.s.added || '').localeCompare(String(a.s.added || '')) || a.index - b.index;
  const personalised = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || byDate(a, b));
  const rest = scored.filter((x) => x.score === 0).sort(byDate);
  return personalised.concat(rest).slice(0, limit).map((x) => ({ ...x.s, personalised: x.score > 0 }));
}

/** «Descubrir»: featured banner, «Para ti», newest and real category counts. */
function discoverSkills({ userId = null, memoryText = '', query = '', category = '', persist = null, root = undefined } = {}) {
  const catalogMod = catalogStore();
  const state = getSkillState({ userId, persist, root });
  const all = (catalogMod ? catalogMod.listCatalogSkills() : []).map((s) => ({
    ...s,
    author: SKILLS_AUTHOR,
    installed: state.installed.has(s.name),
  }));
  const q = String(query || '').trim().toLowerCase().slice(0, 120);
  const cat = String(category || '').trim();
  const items = all.filter((s) => (!cat || s.category === cat)
    && (!q || `${s.name} ${s.title} ${s.description} ${s.category}`.toLowerCase().includes(q)));
  const newest = [...all].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
  return {
    featured: all.find((s) => s.featured) || newest[0] || null,
    forYou: rankForUser(all, memoryText),
    latest: newest.slice(0, 6),
    categories: catalogMod ? catalogMod.catalogCategories(all) : [],
    items,
    total: all.length,
  };
}

// Path segments of /api/skills that a skill name must never shadow.
const ROUTE_RESERVED_NAMES = new Set(['library', 'discover']);

function validateSkillInput({ name, description, body }) {
  const clean = normalizeSkillName(name);
  if (!clean) throw skillError(400, 'invalid_name', 'El nombre solo puede tener minúsculas, números, guiones y guiones bajos (máx. 64).');
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  if (!desc) throw skillError(400, 'description_required', 'Añade una descripción: di qué hace la skill y cuándo usarla.');
  if (desc.length > MAX_DESCRIPTION_CHARS) throw skillError(400, 'description_too_long', `La descripción admite hasta ${MAX_DESCRIPTION_CHARS} caracteres.`);
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw skillError(400, 'body_required', 'Escribe las instrucciones de la skill.');
  if (text.length > 16000) throw skillError(400, 'body_too_long', 'Las instrucciones admiten hasta 16 000 caracteres.');
  return { name: clean, description: desc, body: text };
}

function userSkillExists({ userId, name, persist, root }) {
  return listUserSkills({ userId, persist, root }).some((s) => s.name === name);
}

/** «Escribir instrucciones» / «Subir una skill» / the agent's save_skill. */
function createUserSkill({ userId, name, description, body, overwrite = false, persist = null, root = undefined } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw skillError(401, 'auth_required', 'Inicia sesión para guardar skills.');
  const input = validateSkillInput({ name, description, body });
  const exists = userSkillExists({ userId: uid, name: input.name, persist, root });
  if (ROUTE_RESERVED_NAMES.has(input.name) && !exists) {
    throw skillError(409, 'name_reserved', `«${input.name}» es un nombre reservado. Elige otro.`);
  }
  // Editing an own skill that predates the catalog keeps working; new
  // skills can't take a SiraGPT name.
  if (reservedSkillName(input.name) && !(overwrite && exists)) {
    throw skillError(409, 'name_reserved', `«${input.name}» ya es una skill de SiraGPT. Elige otro nombre.`);
  }
  if (!overwrite && exists) {
    throw skillError(409, 'name_taken', `Ya tienes una skill llamada «${input.name}».`);
  }
  if (!overwrite && listUserSkills({ userId: uid, persist, root }).length >= MAX_USER_SKILLS) {
    throw skillError(409, 'limit_reached', `Puedes tener hasta ${MAX_USER_SKILLS} skills propias.`);
  }
  const store = persistStore(persist);
  if (!store) throw skillError(503, 'store_unavailable', 'Las skills no están disponibles ahora.');
  try {
    store.persistUserSkill(root ? { userId: uid, ...input, root } : { userId: uid, ...input });
  } catch (err) {
    const code = err && err.code;
    if (code === 'payload_too_long' || code === 'invalid_skill_name') throw skillError(400, code, 'La skill no es válida.');
    throw skillError(500, 'persist_failed', 'No se pudo guardar la skill.');
  }
  // A re-created skill comes back switched on.
  const state = getSkillState({ userId: uid, persist, root });
  if (state.disabled.has(input.name)) {
    saveSkillState({ userId: uid, persist, root, state: { ...state.raw, disabled: [...state.disabled].filter((n) => n !== input.name) } });
  }
  return loadChatSkill({ userId: uid, name: input.name, persist, root });
}

function updateUserSkill({ userId, name, description, body, persist = null, root = undefined } = {}) {
  const clean = normalizeSkillName(name);
  if (!clean || !userSkillExists({ userId, name: clean, persist, root })) {
    throw skillError(404, 'not_found', 'Solo puedes editar skills creadas por ti.');
  }
  return createUserSkill({ userId, name: clean, description, body, overwrite: true, persist, root });
}

/** Parse an uploaded SKILL.md (the frontend unzips .zip/.skill packages). */
function parseUploadedSkill(content, fallbackName = '') {
  const text = String(content || '');
  if (!text.trim()) throw skillError(400, 'empty_upload', 'El archivo está vacío.');
  if (text.length > 20000) throw skillError(400, 'upload_too_large', 'El SKILL.md supera los 20 000 caracteres.');
  const base = String(fallbackName || '').toLowerCase().replace(/\.(md|zip|skill)$/i, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const parsed = parseSkillMarkdown(text, base === 'skill' ? '' : base);
  if (!parsed) throw skillError(400, 'invalid_skill', 'No encontré un nombre válido: añade «name:» en el encabezado del SKILL.md.');
  return parsed;
}

function setSkillEnabled({ userId, name, enabled, persist = null, root = undefined } = {}) {
  const uid = String(userId || '').trim();
  const clean = normalizeSkillName(name);
  if (!uid || !clean) throw skillError(400, 'invalid_name', 'Skill no válida.');
  const known = listChatSkills({ userId: uid, persist, root, includeDisabled: true }).some((s) => s.name === clean);
  if (!known) throw skillError(404, 'not_found', 'No tienes esa skill.');
  const state = getSkillState({ userId: uid, persist, root });
  const disabled = new Set(state.disabled);
  if (enabled) disabled.delete(clean); else disabled.add(clean);
  saveSkillState({ userId: uid, persist, root, state: { ...state.raw, disabled: [...disabled] } });
  return { name: clean, enabled: Boolean(enabled) };
}

function installCatalogSkill({ userId, name, persist = null, root = undefined, now = new Date() } = {}) {
  const uid = String(userId || '').trim();
  const clean = normalizeSkillName(name);
  const catalogMod = catalogStore();
  if (!uid) throw skillError(401, 'auth_required', 'Inicia sesión para añadir skills.');
  if (!clean || !catalogMod || !catalogMod.isCatalogSkill(clean)) throw skillError(404, 'not_found', 'Esa skill no está en el catálogo.');
  if (userSkillExists({ userId: uid, name: clean, persist, root })) {
    throw skillError(409, 'name_taken', `Ya tienes una skill propia llamada «${clean}».`);
  }
  const state = getSkillState({ userId: uid, persist, root });
  const installed = { ...(state.raw.installed || {}) };
  if (!installed[clean]) installed[clean] = now.toISOString();
  saveSkillState({
    userId: uid,
    persist,
    root,
    state: {
      installed,
      disabled: [...state.disabled].filter((n) => n !== clean),
      removed: [...state.removed].filter((n) => n !== clean),
    },
  });
  return { name: clean, installed: true };
}

/** Delete an own skill, or uninstall a catalog one. Built-ins can only be switched off. */
function removeSkill({ userId, name, persist = null, root = undefined } = {}) {
  const uid = String(userId || '').trim();
  const clean = normalizeSkillName(name);
  if (!uid || !clean) throw skillError(400, 'invalid_name', 'Skill no válida.');
  if (BUILTIN_BY_NAME.has(clean)) throw skillError(400, 'builtin', 'Las skills integradas no se eliminan; puedes desactivarlas.');
  const state = getSkillState({ userId: uid, persist, root });
  if (userSkillExists({ userId: uid, name: clean, persist, root })) {
    const store = persistStore(persist);
    const res = store.deletePersistedSkill(root ? { userId: uid, name: clean, root } : { userId: uid, name: clean });
    if (!res || !res.ok) throw skillError(500, 'delete_failed', 'No se pudo eliminar la skill.');
    saveSkillState({ userId: uid, persist, root, state: { ...state.raw, disabled: [...state.disabled].filter((n) => n !== clean) } });
    return { name: clean, deleted: true };
  }
  if (state.installed.has(clean)) {
    const installed = { ...(state.raw.installed || {}) };
    delete installed[clean];
    const catalogMod = catalogStore();
    const removed = new Set(state.removed);
    if (catalogMod && catalogMod.DEFAULT_INSTALLED.includes(clean)) removed.add(clean);
    saveSkillState({
      userId: uid,
      persist,
      root,
      state: { installed, disabled: [...state.disabled].filter((n) => n !== clean), removed: [...removed] },
    });
    return { name: clean, uninstalled: true };
  }
  throw skillError(404, 'not_found', 'No tienes esa skill.');
}

/** SKILL.md text for «Descargar». */
function exportSkillMarkdown(skill) {
  if (!skill || !skill.body) return '';
  return `---\nname: ${skill.name}\ndescription: ${String(skill.description || '').replace(/\n/g, ' ')}\n---\n\n${skill.body}\n`;
}

module.exports = {
  BUILTIN_SKILLS,
  BUILTIN_CATEGORY,
  getSkillState,
  saveSkillState,
  reservedSkillName,
  listSkillLibrary,
  discoverSkills,
  rankForUser,
  createUserSkill,
  updateUserSkill,
  parseUploadedSkill,
  setSkillEnabled,
  installCatalogSkill,
  removeSkill,
  exportSkillMarkdown,
  MAX_SELECTED_SKILLS,
  MAX_SKILL_PROMPT_CHARS,
  MAX_TOTAL_PROMPT_CHARS,
  normalizeSkillName,
  normalizeSelectedSkillNames,
  parseSkillMarkdown,
  listChatSkills,
  loadChatSkill,
  resolveSelectedSkills,
  buildSelectedSkillsBlock,
  selectedSkillsSuffix,
  formatSkillsCatalog,
};
