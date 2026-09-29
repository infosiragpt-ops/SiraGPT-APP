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
      out.push({ ...parsed, title: parsed.name, source: 'biblioteca' });
    } catch {
      /* one unreadable skill never hides the others */
    }
  }
  return out;
}

/** Catalog for the picker and the agent: built-ins first, then the Biblioteca. */
function listChatSkills({ userId = null, persist = null, root = undefined } = {}) {
  const builtins = BUILTIN_SKILLS.map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
    source: 'builtin',
  }));
  const seen = new Set(builtins.map((s) => s.name));
  const user = [];
  for (const s of listUserSkills({ userId, persist, root })) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    user.push({ name: s.name, title: s.title, description: s.description, source: s.source });
  }
  return builtins.concat(user);
}

/** One skill with its body, or null. Built-ins win over a same-named user skill. */
function loadChatSkill({ userId = null, name, persist = null, root = undefined, builtinDir = BUILTIN_DIR } = {}) {
  const clean = normalizeSkillName(name);
  if (!clean) return null;
  const builtin = BUILTIN_BY_NAME.get(clean);
  if (builtin) {
    const body = readBuiltinBody(builtin, { dir: builtinDir });
    if (!body) return null;
    return { name: builtin.name, title: builtin.title, description: builtin.description, source: 'builtin', body };
  }
  const uid = String(userId || '').trim();
  const store = persistStore(persist);
  if (!uid || !store) return null;
  try {
    const loaded = store.loadPersistedSkill(root ? { userId: uid, name: clean, root } : { userId: uid, name: clean });
    if (!loaded || !loaded.ok) return null;
    const parsed = parseSkillMarkdown(loaded.body, clean);
    if (!parsed || !parsed.body) return null;
    return { ...parsed, title: parsed.name, source: 'biblioteca' };
  } catch {
    return null;
  }
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

module.exports = {
  BUILTIN_SKILLS,
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
