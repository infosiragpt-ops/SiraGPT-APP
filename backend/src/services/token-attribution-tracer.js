'use strict';

/**
 * token-attribution-tracer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cheap heuristic mapping from output tokens back to input tokens that
 * most likely contributed to them. This is the orchestration-layer
 * analogue of the activation-patching / linear-feature-attribution work
 * in Anthropic's paper: we don't have access to model internals here, so
 * we approximate with lexical + positional overlap and a small set of
 * relationship rules:
 *
 *   1. Exact token match in input → highest attribution.
 *   2. Lemma / stem partial match → medium attribution.
 *   3. Synonym from a small lexicon → medium attribution.
 *   4. Numerical entities in the output get pulled to numerical entities
 *      in the input (in order of appearance).
 *   5. Positional proximity: when multiple inputs match, prefer the
 *      input token closer to the output position (normalised).
 *
 * Output: per-output-token attribution scores with a sorted top-K list
 * of source-token contributors. Suitable for UI hover highlighting
 * ("this word came from this part of the user message / retrieved
 * context") and for "which input made me say X?" diagnostics.
 *
 * Pure JS. Hot path < 50 ms for ~500 input tokens × 200 output tokens.
 *
 * Public API:
 *   trace({ inputs, output, opts? })          → TraceReport
 *   buildTraceBlock(report, opts?)            → string (prompt block)
 *   tokenize(text)                            → string[]
 *
 * Inputs:
 *   inputs: { id, label, text }[]
 *     – `id` and `label` identify the source bucket (e.g. 'user_message',
 *        'rag_chunk_3', 'memory_fact_2').
 *     – `text` is the raw text we attribute against.
 *   output: string
 *
 * Output report:
 *   {
 *     outputTokens: [
 *       {
 *         idx: number,
 *         token: string,
 *         topSources: [{ inputId, inputLabel, token, score }, …],
 *         maxScore: number,
 *       },
 *       …
 *     ],
 *     coverage: number,           // fraction of output tokens with ≥ 1 source
 *     unsupported: number,        // tokens with maxScore < threshold
 *     stats: { inputTokens, outputTokens, durationMs }
 *   }
 */

const STOP = new Set([
  'a','an','the','of','to','in','for','on','with','and','or','that','this','it','is',
  'are','was','were','as','at','by','from','de','la','el','los','las','un','una','y',
  'o','que','en','para','por','con','sin','sobre','del','al','mi','tu','su','sus','me',
  'te','se','lo','le','sea','sean','si','no','ni','pero',
]);

const TOKEN_RE = /[a-záéíóúñü0-9_-]+/giu;

// tiny EN↔ES synonym + plural alias map. Pure JS so this stays cheap.
const SYNONYMS = Object.freeze({
  function: ['función', 'metodo', 'method'],
  función: ['function', 'metodo', 'method'],
  deploy: ['despliegue', 'deployment'],
  despliegue: ['deploy', 'deployment'],
  bug: ['error', 'falla', 'fault'],
  error: ['bug', 'falla', 'fault'],
  user: ['users', 'usuario', 'usuarios', 'customer'],
  customer: ['cliente', 'clientes', 'user'],
  revenue: ['ingresos', 'ventas', 'sales'],
  sales: ['ventas', 'revenue', 'ingresos'],
  chart: ['gráfica', 'graph', 'gráfico'],
  graph: ['gráfica', 'chart', 'gráfico'],
  backend: ['servidor', 'server'],
  frontend: ['cliente', 'ui'],
});

const NUMBER_RE = /^\d[\d.,]*(%|usd|eur|€|\$|gb|mb|kb|s|ms|h|d|y)?$/i;

function tokenize(text) {
  if (!text) return [];
  const out = [];
  const matches = String(text).toLowerCase().match(TOKEN_RE);
  if (!matches) return out;
  for (const t of matches) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

function stem(token) {
  // very crude — strip common suffixes
  return token
    .replace(/(?:tions?|sions?|ments?|ities?|aries?|ologies?)$/i, '')
    .replace(/(?:ings?|ed|er|est|ly|ies)$/i, '')
    .replace(/(?:ciones?|miento|s)$/i, '')
    .slice(0, 12);
}

function tokensWithIdx(text) {
  const tokens = tokenize(text);
  return tokens.map((token, i) => ({ token, idx: i, stem: stem(token) }));
}

function isNumberLike(token) {
  return NUMBER_RE.test(token);
}

function bestMatchForOutputToken(outTok, inputBuckets, opts) {
  const exactBoost = opts.exactBoost ?? 1.0;
  const stemBoost = opts.stemBoost ?? 0.7;
  const synonymBoost = opts.synonymBoost ?? 0.6;
  const numericBoost = opts.numericBoost ?? 0.9;
  const positionalWeight = opts.positionalWeight ?? 0.15;
  const top = [];
  for (const bucket of inputBuckets) {
    for (const it of bucket.tokens) {
      let score = 0;
      if (it.token === outTok.token) score = exactBoost;
      else if (it.stem && outTok.stem && it.stem === outTok.stem) score = stemBoost;
      else if (SYNONYMS[outTok.token] && SYNONYMS[outTok.token].includes(it.token)) score = synonymBoost;
      else if (SYNONYMS[it.token] && SYNONYMS[it.token].includes(outTok.token)) score = synonymBoost;
      else if (isNumberLike(outTok.token) && isNumberLike(it.token)) score = numericBoost * 0.7;
      if (score === 0) continue;
      // positional proximity bonus (small) — prefer earlier inputs for early outputs
      const norm = bucket.tokens.length > 0 ? it.idx / Math.max(1, bucket.tokens.length) : 0;
      const outNorm = outTok.normalisedIdx;
      const positionalBonus = positionalWeight * (1 - Math.abs(norm - outNorm));
      const finalScore = Math.min(1, score + positionalBonus * 0.1);
      top.push({
        inputId: bucket.id,
        inputLabel: bucket.label,
        token: it.token,
        score: Number(finalScore.toFixed(3)),
      });
    }
  }
  top.sort((a, b) => b.score - a.score);
  return top;
}

/**
 * Trace every output token back to its top contributing input tokens.
 *
 * @param {object} args
 * @param {Array}  args.inputs   { id, label, text }[]
 * @param {string} args.output
 * @param {object} [args.opts]
 *   - topK            number of contributors per output token (default 3)
 *   - threshold       min score to count as "supported" (default 0.4)
 *   - maxOutputTokens cap on tokens to analyse (default 200)
 *   - exactBoost / stemBoost / synonymBoost / numericBoost / positionalWeight
 * @returns {object} TraceReport
 */
function trace({ inputs = [], output = '', opts = {} } = {}) {
  const t0 = Date.now();
  const topK = Math.max(1, Math.min(10, Number(opts.topK) || 3));
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 0.4;
  const maxOutputTokens = Math.max(1, Number(opts.maxOutputTokens) || 200);

  const inputBuckets = (Array.isArray(inputs) ? inputs : [])
    .filter((b) => b && typeof b.text === 'string')
    .map((b, i) => ({
      id: b.id || `input_${i}`,
      label: b.label || b.id || `input_${i}`,
      tokens: tokensWithIdx(b.text),
    }));

  const outputTokensRaw = tokensWithIdx(output).slice(0, maxOutputTokens);
  const totalOut = Math.max(1, outputTokensRaw.length);
  const outputTokensWithPos = outputTokensRaw.map((t) => ({
    ...t,
    normalisedIdx: t.idx / totalOut,
  }));

  let supported = 0;
  let unsupported = 0;
  const outputTokens = outputTokensWithPos.map((tok) => {
    const ranked = bestMatchForOutputToken(tok, inputBuckets, opts).slice(0, topK);
    const maxScore = ranked.length > 0 ? ranked[0].score : 0;
    if (maxScore >= threshold) supported += 1;
    else unsupported += 1;
    return { idx: tok.idx, token: tok.token, topSources: ranked, maxScore };
  });

  const totalInputTokens = inputBuckets.reduce((a, b) => a + b.tokens.length, 0);

  return {
    outputTokens,
    coverage: Number((supported / Math.max(1, outputTokens.length)).toFixed(3)),
    unsupported,
    supported,
    stats: {
      inputTokens: totalInputTokens,
      outputTokens: outputTokens.length,
      durationMs: Date.now() - t0,
    },
  };
}

function buildTraceBlock(report, opts = {}) {
  if (!report || !Array.isArray(report.outputTokens)) return '';
  const supported = report.supported || 0;
  const total = report.outputTokens.length || 1;
  const coveragePct = Math.round((supported / total) * 100);
  const maxSamples = Number(opts.maxSamples) || 5;
  const lines = ['\n\n<token_attribution>'];
  lines.push(`Cobertura del output: ${coveragePct}% (${supported}/${total} tokens con respaldo).`);
  if (report.unsupported > 0) {
    const unsup = report.outputTokens.filter((t) => t.maxScore < (opts.threshold || 0.4)).slice(0, maxSamples);
    lines.push(`Tokens sin respaldo claro (${report.unsupported}): ${unsup.map((t) => `"${t.token}"`).join(', ')}`);
  }
  // sample a few well-supported tokens
  const supportedSamples = report.outputTokens
    .filter((t) => t.maxScore >= (opts.threshold || 0.4) && t.topSources.length > 0)
    .slice(0, maxSamples);
  if (supportedSamples.length > 0) {
    lines.push('Ejemplos de tokens bien atribuidos:');
    for (const t of supportedSamples) {
      const src = t.topSources[0];
      lines.push(`  • "${t.token}" ← [${src.inputLabel}] "${src.token}" (score ${src.score})`);
    }
  }
  lines.push('</token_attribution>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1200;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  trace,
  buildTraceBlock,
  tokenize,
  stem,
  SYNONYMS,
};
