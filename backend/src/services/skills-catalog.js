'use strict';

/**
 * skills-catalog — the «Descubrir» catalog of Ajustes → Skills (claude.ai
 * style). Curated SKILL.md playbooks shipped with the platform under
 * services/skills-catalog/*.md; a user installs one with «+» (it then shows
 * in «Tuyos», in «+ → Skills» and with «/») or tries it with «Probar»
 * without installing.
 *
 * Frontmatter (one `key: value` per line):
 *   name, title, description, category, added (YYYY-MM-DD), featured (true)
 *
 * Read once and cached; `reloadCatalog()` is for tests. Never throws.
 */

const fs = require('fs');
const path = require('path');

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CATALOG_DIR = path.join(__dirname, 'skills-catalog');
const MAX_DESCRIPTION_CHARS = 160;

/** Skills installed for everyone until the user removes them (claude.ai ships skill-creator). */
const DEFAULT_INSTALLED = Object.freeze(['skill-creator']);

let cache = null;

function parseCatalogFile(raw, fallbackName) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split('\n')) {
    const m = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const name = String(meta.name || fallbackName || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(name)) return null;
  const body = text.slice(fm[0].length).trim();
  if (!body) return null;
  const added = meta.added && !Number.isNaN(Date.parse(meta.added)) ? meta.added : null;
  return {
    name,
    title: meta.title || name,
    description: String(meta.description || '').slice(0, MAX_DESCRIPTION_CHARS),
    category: meta.category || 'General',
    added,
    featured: String(meta.featured || '').toLowerCase() === 'true',
    body,
  };
}

function loadCatalog({ dir = CATALOG_DIR } = {}) {
  const items = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return items;
  }
  for (const file of files) {
    try {
      const parsed = parseCatalogFile(fs.readFileSync(path.join(dir, file), 'utf8'), file.replace(/\.md$/, ''));
      if (parsed && !items.some((s) => s.name === parsed.name)) items.push(parsed);
    } catch {
      /* one unreadable file never hides the others */
    }
  }
  return items;
}

function catalog() {
  if (!cache) cache = loadCatalog();
  return cache;
}

function reloadCatalog(opts) {
  cache = loadCatalog(opts);
  return cache;
}

function listCatalogSkills() {
  return catalog().map(({ body, ...meta }) => ({ ...meta }));
}

function getCatalogSkill(name) {
  const clean = String(name || '').trim().toLowerCase();
  return catalog().find((s) => s.name === clean) || null;
}

function isCatalogSkill(name) {
  return Boolean(getCatalogSkill(name));
}

/** Categories with real counts, largest first (ties alphabetical). */
function catalogCategories(items = listCatalogSkills()) {
  const counts = new Map();
  for (const s of items) counts.set(s.category, (counts.get(s.category) || 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

module.exports = {
  CATALOG_DIR,
  DEFAULT_INSTALLED,
  parseCatalogFile,
  loadCatalog,
  reloadCatalog,
  listCatalogSkills,
  getCatalogSkill,
  isCatalogSkill,
  catalogCategories,
};
