/**
 * semantic-model — the Business Intelligence Studio's compiler
 * from an abstract `{facts, dimensions, measures, filters}` spec
 * into a concrete star-schema JSON ready for a dashboard renderer.
 *
 * This is pure logic: no DB driver, no rendering. A caller (the
 * Dashboard Builder, a notebook, an LLM planner) hands us the
 * domain description and we return:
 *
 *   {
 *     schema:    star-schema model (facts + dimensions + relationships)
 *     measures:  compiled DAX-like measure definitions
 *     kpis:      KPI card descriptors derived from measures + thresholds
 *     validation: { ok, errors, warnings }
 *   }
 *
 * Validation enforces:
 *   - unique fact / dimension names
 *   - every relationship uses an existing column on both sides
 *   - measure expressions reference only declared columns
 *   - no orphan dimensions (every dimension is referenced by at
 *     least one fact)
 *   - no circular relationships between dimensions
 */

const MEASURE_AGG = ["sum", "avg", "min", "max", "count", "count_distinct", "median", "p90", "p95", "ratio", "custom"];

function uniqueNames(list, prop = "name") {
  const seen = new Set();
  const dups = [];
  for (const item of list || []) {
    const n = String(item?.[prop] || "").trim();
    if (!n) continue;
    if (seen.has(n)) dups.push(n);
    seen.add(n);
  }
  return { seen, dups };
}

function normaliseColumn(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { name: raw, type: "unknown" };
  if (typeof raw !== "object") return null;
  if (!raw.name) return null;
  return {
    name: String(raw.name),
    type: raw.type ? String(raw.type) : "unknown",
    nullable: raw.nullable !== false,
    description: raw.description ? String(raw.description) : undefined,
    format: raw.format ? String(raw.format) : undefined,
  };
}

function validateSemanticModel(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== "object") {
    errors.push({ code: "bad_spec", detail: "semantic-model: spec must be an object" });
    return { ok: false, errors, warnings };
  }
  const facts = Array.isArray(spec.facts) ? spec.facts : [];
  const dimensions = Array.isArray(spec.dimensions) ? spec.dimensions : [];
  const measures = Array.isArray(spec.measures) ? spec.measures : [];

  if (facts.length === 0) errors.push({ code: "no_facts", detail: "At least one fact table is required." });

  const factNames = uniqueNames(facts);
  for (const d of factNames.dups) errors.push({ code: "duplicate_fact", detail: `Duplicate fact name "${d}".` });
  const dimNames = uniqueNames(dimensions);
  for (const d of dimNames.dups) errors.push({ code: "duplicate_dimension", detail: `Duplicate dimension name "${d}".` });

  // Validate per-fact columns + relationships
  const factColumns = new Map();
  const dimColumns = new Map();
  for (const f of facts) {
    if (!f?.name) continue;
    const cols = (Array.isArray(f.columns) ? f.columns : []).map(normaliseColumn).filter(Boolean);
    factColumns.set(f.name, new Set(cols.map(c => c.name)));
  }
  for (const d of dimensions) {
    if (!d?.name) continue;
    const cols = (Array.isArray(d.columns) ? d.columns : []).map(normaliseColumn).filter(Boolean);
    dimColumns.set(d.name, new Set(cols.map(c => c.name)));
  }

  const relationships = [];
  const dimsReferenced = new Set();
  for (const f of facts) {
    if (!f?.name) continue;
    for (const rel of f.relationships || []) {
      if (!rel || typeof rel !== "object") continue;
      const factCol = rel.fact_column;
      const dim = rel.dimension;
      const dimCol = rel.dimension_column;
      const name = `${f.name}.${factCol} → ${dim}.${dimCol}`;
      if (!factColumns.get(f.name)?.has(factCol)) {
        errors.push({ code: "relationship_missing_fact_col", detail: `${name}: fact column ${factCol} missing on fact ${f.name}` });
      }
      if (!dimColumns.has(dim)) {
        errors.push({ code: "relationship_missing_dimension", detail: `${name}: dimension ${dim} not defined` });
        continue;
      }
      if (!dimColumns.get(dim).has(dimCol)) {
        errors.push({ code: "relationship_missing_dim_col", detail: `${name}: dimension column ${dimCol} missing on dim ${dim}` });
      }
      relationships.push({ fact: f.name, fact_column: factCol, dimension: dim, dimension_column: dimCol });
      dimsReferenced.add(dim);
    }
  }

  // Orphan dimensions
  for (const d of dimensions) {
    if (!d?.name) continue;
    if (!dimsReferenced.has(d.name)) warnings.push({ code: "orphan_dimension", detail: `Dimension "${d.name}" is declared but no fact references it.` });
  }

  // Circular-dimension relationships
  // (a dimension pointing to another dimension is unusual; if declared, ensure no loops)
  const dimGraph = new Map();
  for (const d of dimensions) {
    if (!d?.name) continue;
    dimGraph.set(d.name, []);
    for (const rel of d.relationships || []) {
      if (rel?.dimension) dimGraph.get(d.name).push(rel.dimension);
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colour = new Map([...dimGraph.keys()].map(k => [k, WHITE]));
  const visit = (n, trail) => {
    if (colour.get(n) === GRAY) {
      errors.push({ code: "dimension_cycle", detail: `Dimension cycle: ${trail.concat(n).join(" → ")}` });
      return;
    }
    if (colour.get(n) === BLACK) return;
    colour.set(n, GRAY);
    for (const next of dimGraph.get(n) || []) visit(next, trail.concat(n));
    colour.set(n, BLACK);
  };
  for (const k of dimGraph.keys()) visit(k, []);

  // Measure column references
  const allColumns = new Map();
  for (const [fact, cols] of factColumns) {
    for (const col of cols) allColumns.set(`${fact}.${col}`, true);
  }
  for (const [dim, cols] of dimColumns) {
    for (const col of cols) allColumns.set(`${dim}.${col}`, true);
  }
  for (const m of measures) {
    if (!m?.name) { errors.push({ code: "measure_nameless", detail: "A measure without a name was declared." }); continue; }
    if (m.agg && !MEASURE_AGG.includes(m.agg)) errors.push({ code: "measure_unknown_agg", detail: `Measure "${m.name}" uses unknown agg "${m.agg}" (allowed: ${MEASURE_AGG.join(", ")})` });
    if (Array.isArray(m.columns)) {
      for (const ref of m.columns) {
        if (typeof ref === "string" && ref.includes(".") && !allColumns.has(ref)) {
          errors.push({ code: "measure_column_missing", detail: `Measure "${m.name}" references unknown column ${ref}` });
        }
      }
    }
    if (m.agg === "ratio" && (!m.numerator || !m.denominator)) {
      errors.push({ code: "measure_ratio_incomplete", detail: `Ratio measure "${m.name}" needs numerator and denominator.` });
    }
    if (m.agg === "custom" && !m.expression) {
      errors.push({ code: "measure_custom_no_expr", detail: `Custom measure "${m.name}" needs expression.` });
    }
  }

  return { ok: errors.length === 0, errors, warnings, relationships };
}

function buildStarSchema(spec) {
  const v = validateSemanticModel(spec);
  if (!v.ok) {
    return { ok: false, schema: null, validation: v };
  }
  const schema = {
    facts: (spec.facts || []).map(f => ({
      name: f.name,
      grain: f.grain || null,
      description: f.description || null,
      columns: (f.columns || []).map(normaliseColumn).filter(Boolean),
      foreign_keys: (f.relationships || []).map(r => ({ column: r.fact_column, references: `${r.dimension}.${r.dimension_column}` })),
    })),
    dimensions: (spec.dimensions || []).map(d => ({
      name: d.name,
      description: d.description || null,
      columns: (d.columns || []).map(normaliseColumn).filter(Boolean),
      scd_type: d.scd_type || "type-1",
    })),
    relationships: v.relationships,
  };
  return { ok: true, schema, validation: v };
}

function compileMeasure(m) {
  if (!m || typeof m !== "object") return null;
  const name = m.name;
  switch (m.agg) {
    case "sum":
    case "avg":
    case "min":
    case "max":
    case "median":
    case "p90":
    case "p95": {
      const col = Array.isArray(m.columns) && m.columns[0] ? m.columns[0] : null;
      return {
        name,
        agg: m.agg,
        expression: col ? `${m.agg.toUpperCase()}(${col})` : null,
        format: m.format || null,
        thresholds: m.thresholds || null,
        description: m.description || null,
      };
    }
    case "count":
      return { name, agg: "count", expression: `COUNT(*)`, format: m.format || "0,0" };
    case "count_distinct": {
      const col = m.columns?.[0] || null;
      return { name, agg: "count_distinct", expression: col ? `COUNTDISTINCT(${col})` : "COUNTDISTINCT(*)", format: m.format || "0,0" };
    }
    case "ratio":
      return {
        name,
        agg: "ratio",
        expression: `DIVIDE(${m.numerator}, ${m.denominator})`,
        format: m.format || "0.00%",
      };
    case "custom":
      return { name, agg: "custom", expression: m.expression, format: m.format || null };
    default:
      return null;
  }
}

function compileMeasures(spec) {
  const out = [];
  for (const m of spec?.measures || []) {
    const cm = compileMeasure(m);
    if (cm) out.push(cm);
  }
  return out;
}

function deriveKpiCards(spec) {
  const cards = [];
  for (const m of spec?.measures || []) {
    if (!m?.kpi) continue;
    const card = {
      id: m.name,
      label: m.label || m.name,
      measure: m.name,
      format: m.format || null,
      thresholds: m.thresholds || null,
      target: m.target ?? null,
      comparison: m.comparison || null,
      trend: m.trend || null,
    };
    cards.push(card);
  }
  return cards;
}

/**
 * End-to-end: spec → { schema, measures, kpis, validation }.
 */
function compileSemanticModel(spec) {
  const { schema, ok, validation } = buildStarSchema(spec);
  const measures = compileMeasures(spec);
  const kpis = deriveKpiCards(spec);
  return { ok, schema, measures, kpis, validation };
}

module.exports = {
  validateSemanticModel,
  buildStarSchema,
  compileMeasure,
  compileMeasures,
  deriveKpiCards,
  compileSemanticModel,
  MEASURE_AGG,
};
