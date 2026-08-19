'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyIntent } = require('../src/services/master-prompt');

// Each row: [input, expectedIntent].
// Positive cases assert ANALYZE_FILE detection across the expanded
// regex set. Negative cases guard against regressions where a generic
// chat message (no file ref) accidentally routes into ANALYZE_FILE
// and then injects ~3 KB of recipe boilerplate the model doesn't need.

const POSITIVE = [
  // Verb + file noun (legacy).
  ['Analiza el archivo adjunto', 'ANALYZE_FILE'],
  ['Resume el documento', 'ANALYZE_FILE'],
  ['Revisa el pdf', 'ANALYZE_FILE'],
  ['Summarize the spreadsheet', 'ANALYZE_FILE'],
  ['Extract data from the excel', 'ANALYZE_FILE'],
  // Verb + domain-specific document noun (new).
  ['Analiza este contrato profesionalmente', 'ANALYZE_FILE'],
  ['Revisa el contrato adjunto', 'ANALYZE_FILE'],
  ['Resume este paper', 'ANALYZE_FILE'],
  ['Analyze the report', 'ANALYZE_FILE'],
  ['Audita la factura', 'ANALYZE_FILE'],
  ['Evalúa esta tesis', 'ANALYZE_FILE'],
  ['Critica el informe', 'ANALYZE_FILE'],
  // Object first, then verb.
  ['El contrato adjunto, analízalo', 'ANALYZE_FILE'],
  ['The report — give me insights', 'ANALYZE_FILE'],
  ['CV del candidato, dame opinión', 'ANALYZE_FILE'],
  // "What does X say".
  ['Qué dice este pdf?', 'ANALYZE_FILE'],
  ['What does the document say', 'ANALYZE_FILE'],
  ['De qué trata el contrato', 'ANALYZE_FILE'],
  ['Qué contiene el archivo', 'ANALYZE_FILE'],
  // "Explain this <noun>".
  ['Explícame el documento', 'ANALYZE_FILE'],
  ['Explain this contract', 'ANALYZE_FILE'],
  ['Describe el reporte', 'ANALYZE_FILE'],
  // Opinion-seeking on attached docs.
  ['Qué opinas del cv', 'ANALYZE_FILE'],
  ['Qué piensas sobre el informe', 'ANALYZE_FILE'],
  ['Qué recomiendas sobre el contrato', 'ANALYZE_FILE'],
  // Insight / takeaway extraction.
  ['Dame insights del informe', 'ANALYZE_FILE'],
  ['Give me findings on the report', 'ANALYZE_FILE'],
  ['Sácame los puntos clave del documento', 'ANALYZE_FILE'],
  // Profession framing — always activates the recipe.
  ['Analízalo como abogado', 'ANALYZE_FILE'],
  ['As a CFO, review this', 'ANALYZE_FILE'],
  ['Como reclutador, evalúa el CV', 'ANALYZE_FILE'],
  ['Como auditor, revisa los estados', 'ANALYZE_FILE'],
];

const NEGATIVE = [
  // Pure conversational — must not load the analysis recipe.
  ['Hola, cómo estás?', 'GENERAL_CHAT'],
  ['Gracias!', 'GENERAL_CHAT'],
  ['Buenos días', 'GENERAL_CHAT'],
  // Abstract analysis WITHOUT file or doc-noun reference — stays general.
  ['Analiza la situación económica', 'GENERAL_CHAT'],
  ['Cuéntame algo interesante', 'GENERAL_CHAT'],
  // Document GENERATION (not analysis) — must route to GENERATE_DOCUMENT
  // since the rule is higher in INTENT_RULES order.
  ['Crea un documento Word con un informe ejecutivo', 'GENERATE_DOCUMENT'],
  ['Generate a PDF report', 'GENERATE_DOCUMENT'],
  // Code requests should stay in CODE_EXECUTION even if "documentation"
  // appears as a generic word.
  ['Escribe la función Python para esto', 'CODE_EXECUTION'],
];

for (const [input, expected] of POSITIVE) {
  test(`classifyIntent positive: "${input}" → ${expected}`, () => {
    const r = classifyIntent(input);
    assert.equal(r.intent, expected, `got ${r.intent}`);
  });
}

for (const [input, expected] of NEGATIVE) {
  test(`classifyIntent negative: "${input}" → ${expected}`, () => {
    const r = classifyIntent(input);
    assert.equal(r.intent, expected, `got ${r.intent}`);
  });
}

test('ANALYZE_FILE context includes professional structure scaffolding', () => {
  const r = classifyIntent('Analiza este contrato');
  assert.equal(r.intent, 'ANALYZE_FILE');
  assert.match(r.context, /PROFESSIONAL FILE ANALYSIS/);
  assert.match(r.context, /ATTACHED DOCUMENT PROFILE/);
  assert.match(r.context, /PROFESSIONAL ANALYSIS DIRECTIVE/);
  assert.match(r.context, /Cite every claim with its location/);
  assert.match(r.context, /Never invent content/);
});
