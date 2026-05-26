/**
 * market-frameworks — structured shapes + validators for classical
 * strategy analyses the BI Studio needs to surface:
 *
 *   - TAM / SAM / SOM size-of-opportunity computation
 *   - Porter's Five Forces scored 1..5 per axis
 *   - SWOT (strengths/weaknesses/opportunities/threats) buckets
 *   - PESTEL (Political, Economic, Social, Tech, Environmental, Legal)
 *   - Unit economics / CAC / LTV / LTV-to-CAC ratio
 *   - Cohort retention table (trivial — just validates shape)
 *
 * Every function is pure and deterministic. Errors are returned
 * as findings with severity so the QA Board can bubble them up
 * without the caller hand-writing error handling.
 */

// ─── TAM / SAM / SOM ────────────────────────────────────────────────────

/**
 * Compute size-of-opportunity from a simple spec.
 *
 * Valid shapes:
 *   { universeCount, pricePerUnitYear, serviceableRatio, obtainablePct }
 *
 * where:
 *   TAM = universeCount * pricePerUnitYear
 *   SAM = TAM * serviceableRatio         (0..1)
 *   SOM = SAM * obtainablePct             (0..1)
 */
function computeTamSamSom(spec) {
  const findings = [];
  if (!spec || typeof spec !== "object") {
    return { ok: false, findings: [{ severity: "high", code: "bad_spec", detail: "TAM/SAM/SOM spec must be an object." }] };
  }
  const { universeCount, pricePerUnitYear, serviceableRatio = 1, obtainablePct = 0.05 } = spec;
  if (!Number.isFinite(universeCount) || universeCount < 0) findings.push({ severity: "high", code: "universe_count_invalid", detail: "universeCount must be a non-negative number." });
  if (!Number.isFinite(pricePerUnitYear) || pricePerUnitYear < 0) findings.push({ severity: "high", code: "price_invalid", detail: "pricePerUnitYear must be a non-negative number." });
  if (serviceableRatio < 0 || serviceableRatio > 1) findings.push({ severity: "medium", code: "serviceable_ratio_oob", detail: "serviceableRatio must be within [0,1]." });
  if (obtainablePct < 0 || obtainablePct > 1) findings.push({ severity: "medium", code: "obtainable_pct_oob", detail: "obtainablePct must be within [0,1]." });
  if (findings.some(f => f.severity === "high")) {
    return { ok: false, findings };
  }
  const tam = universeCount * pricePerUnitYear;
  const sam = tam * serviceableRatio;
  const som = sam * obtainablePct;
  return {
    ok: true,
    findings,
    tam,
    sam,
    som,
    ratios: {
      samOverTam: tam > 0 ? sam / tam : 0,
      somOverSam: sam > 0 ? som / sam : 0,
    },
  };
}

// ─── Porter's Five Forces ──────────────────────────────────────────────

const PORTER_AXES = Object.freeze([
  "supplierPower",
  "buyerPower",
  "newEntrantsThreat",
  "substitutesThreat",
  "competitiveRivalry",
]);

/**
 * Each axis scored 1..5 (5 = most threatening). Returns findings
 * for out-of-range values and the overall industry-attractiveness
 * score (5 - average), where higher = more attractive.
 */
function scorePorterFiveForces(scores, notes = {}) {
  const findings = [];
  const out = {};
  if (!scores || typeof scores !== "object") {
    return { ok: false, findings: [{ severity: "high", code: "bad_scores", detail: "Porter scores must be an object." }] };
  }
  for (const axis of PORTER_AXES) {
    const v = scores[axis];
    if (!Number.isFinite(v)) {
      findings.push({ severity: "high", code: "axis_missing", detail: `Axis ${axis} missing or not a number.` });
      continue;
    }
    if (v < 1 || v > 5) {
      findings.push({ severity: "medium", code: "axis_oob", detail: `Axis ${axis} = ${v}, expected 1..5.` });
    }
    out[axis] = { score: v, note: typeof notes[axis] === "string" ? notes[axis].slice(0, 400) : null };
  }
  const numeric = PORTER_AXES.map(k => out[k]?.score).filter(n => Number.isFinite(n));
  const avgThreat = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : 0;
  return {
    ok: findings.every(f => f.severity !== "high"),
    findings,
    axes: out,
    averageThreat: Math.round(avgThreat * 100) / 100,
    attractivenessScore: Math.round((5 - avgThreat) * 100) / 100,
  };
}

// ─── SWOT ──────────────────────────────────────────────────────────────

const SWOT_BUCKETS = ["strengths", "weaknesses", "opportunities", "threats"];

function buildSwot(spec) {
  const findings = [];
  const out = {};
  for (const k of SWOT_BUCKETS) {
    const items = Array.isArray(spec?.[k]) ? spec[k] : [];
    if (items.length === 0) findings.push({ severity: "low", code: `swot_empty_${k}`, detail: `SWOT ${k} has no items.` });
    out[k] = items.map(s => String(s || "").trim()).filter(Boolean).slice(0, 20);
  }
  return { ok: true, findings, matrix: out };
}

// ─── PESTEL ────────────────────────────────────────────────────────────

const PESTEL_FACTORS = ["political", "economic", "social", "technological", "environmental", "legal"];

function buildPestel(spec) {
  const findings = [];
  const out = {};
  for (const k of PESTEL_FACTORS) {
    const items = Array.isArray(spec?.[k]) ? spec[k] : [];
    if (items.length === 0) findings.push({ severity: "low", code: `pestel_empty_${k}`, detail: `PESTEL ${k} has no factors.` });
    out[k] = items.map(s => String(s || "").trim()).filter(Boolean).slice(0, 20);
  }
  return { ok: true, findings, factors: out };
}

// ─── Unit economics ────────────────────────────────────────────────────

/**
 * @param {object} inputs
 * @param {number} inputs.arpu      average revenue per user / month
 * @param {number} inputs.cogs      cost-of-goods per user / month
 * @param {number} inputs.monthlyChurnPct      fraction 0..1
 * @param {number} inputs.cac       acquisition cost per user
 */
function computeUnitEconomics({ arpu, cogs, monthlyChurnPct, cac }) {
  const findings = [];
  const toFin = v => (Number.isFinite(v) ? v : NaN);
  arpu = toFin(arpu); cogs = toFin(cogs); monthlyChurnPct = toFin(monthlyChurnPct); cac = toFin(cac);
  if (!Number.isFinite(arpu) || arpu < 0) findings.push({ severity: "high", code: "arpu_invalid", detail: "arpu must be non-negative." });
  if (!Number.isFinite(cogs) || cogs < 0) findings.push({ severity: "high", code: "cogs_invalid", detail: "cogs must be non-negative." });
  if (!Number.isFinite(monthlyChurnPct) || monthlyChurnPct <= 0 || monthlyChurnPct > 1) findings.push({ severity: "high", code: "churn_invalid", detail: "monthlyChurnPct must be in (0,1]." });
  if (!Number.isFinite(cac) || cac < 0) findings.push({ severity: "high", code: "cac_invalid", detail: "cac must be non-negative." });
  if (findings.some(f => f.severity === "high")) return { ok: false, findings };

  const grossMargin = arpu - cogs;
  const avgLifetimeMonths = 1 / monthlyChurnPct;
  const ltv = grossMargin * avgLifetimeMonths;
  const ltvToCac = cac > 0 ? ltv / cac : Infinity;
  const paybackMonths = grossMargin > 0 ? cac / grossMargin : Infinity;

  const quality = ltvToCac >= 3 && paybackMonths <= 12 ? "strong"
    : ltvToCac >= 1.5 ? "acceptable"
    : "weak";
  if (quality === "weak") findings.push({ severity: "medium", code: "ltv_to_cac_weak", detail: `LTV/CAC = ${ltvToCac.toFixed(2)} below 1.5.` });

  return {
    ok: findings.every(f => f.severity !== "high"),
    findings,
    grossMargin: Math.round(grossMargin * 100) / 100,
    avgLifetimeMonths: Math.round(avgLifetimeMonths * 10) / 10,
    ltv: Math.round(ltv * 100) / 100,
    ltvToCac: Number.isFinite(ltvToCac) ? Math.round(ltvToCac * 100) / 100 : null,
    paybackMonths: Number.isFinite(paybackMonths) ? Math.round(paybackMonths * 10) / 10 : null,
    quality,
  };
}

// ─── Cohort retention table (just validate + pivot) ────────────────────

/**
 * @param {Array<{cohort: string, month0: number, month1?: number, month2?: number, ...}>} rows
 */
function buildCohortTable(rows) {
  if (!Array.isArray(rows)) return { ok: false, findings: [{ severity: "high", code: "rows_not_array", detail: "cohort rows must be an array." }] };
  const findings = [];
  const table = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const cohort = String(r.cohort || "").trim();
    if (!cohort) { findings.push({ severity: "medium", code: "cohort_missing_id", detail: "Row missing cohort id." }); continue; }
    const row = { cohort, months: {} };
    for (const [k, v] of Object.entries(r)) {
      const m = k.match(/^month(\d+)$/);
      if (!m) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        findings.push({ severity: "medium", code: "retention_oob", detail: `${cohort}.${k}=${v} — expected 0..1.` });
        continue;
      }
      row.months[Number(m[1])] = n;
    }
    table.push(row);
  }
  return { ok: findings.every(f => f.severity !== "high"), findings, table };
}

module.exports = {
  computeTamSamSom,
  scorePorterFiveForces,
  buildSwot,
  buildPestel,
  computeUnitEconomics,
  buildCohortTable,
  PORTER_AXES,
  SWOT_BUCKETS,
  PESTEL_FACTORS,
};
