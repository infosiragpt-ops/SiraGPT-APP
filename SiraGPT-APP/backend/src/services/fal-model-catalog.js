'use strict';

// Runtime accessor for the generated fal.ai creative-model catalog. The catalog
// JSON is produced offline by scripts/build-fal-catalog.js (re-run to refresh),
// so this module does no network I/O — it just filters/serves the baked list.

let generated;
try {
  generated = require('./fal/fal-model-catalog.generated.json');
} catch (_err) {
  generated = { count: 0, byGroup: {}, models: [] };
}

const GROUPS = ['image', 'video', 'audio', '3d'];

function allModels() {
  return Array.isArray(generated.models) ? generated.models : [];
}

/**
 * Filter the catalog. `group` ∈ image|video|audio|3d|all; `search` matches name,
 * brand or endpoint id; results stay in quality-desc order.
 */
function listFalModels({ group, search, limit } = {}) {
  let models = allModels();
  if (group && group !== 'all') {
    const g = String(group).toLowerCase();
    models = models.filter((m) => m.group === g);
  }
  if (search) {
    const q = String(search).toLowerCase().trim();
    if (q) {
      models = models.filter((m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.brand.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q));
    }
  }
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) models = models.slice(0, n);
  return models;
}

function getFalCatalog() {
  return {
    count: generated.count || allModels().length,
    groups: GROUPS,
    byGroup: generated.byGroup || {},
    models: allModels(),
  };
}

function findFalModel(id) {
  return allModels().find((m) => m.id === id) || null;
}

module.exports = { GROUPS, allModels, listFalModels, getFalCatalog, findFalModel };
