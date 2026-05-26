/**
 * graphrag/adaptive-benchmark — generate sensemaking queries for
 * YOUR corpus, not a generic benchmark.
 *
 * Edge et al. 2024 (GraphRAG §2.3): "We propose an adaptive
 * benchmarking approach to generating global sensemaking queries.
 * Our approach builds on prior work in LLM-based persona generation
 * ... specifically, our approach uses the LLM to infer the potential
 * users [who] would use the RAG system and their use cases, which
 * guide the generation of corpus-specific sensemaking queries."
 *
 * Two-stage:
 *   1. PERSONA GENERATION — given a short corpus summary + description
 *      of the intended users, LLM proposes N realistic personas
 *      (role, motivation, background). Diverse enough to cover the
 *      real user base, not a single archetype.
 *   2. QUERY GENERATION — for each persona, LLM generates M
 *      sensemaking questions the persona would actually ask. These
 *      are GLOBAL questions ("what are the trends...?"), not
 *      specific-fact lookups.
 *
 * Output: a persona-labeled query set you can run your pipeline
 * against with eval-harness or RAGAS batch mode.
 *
 * IMPORTANT per paper §2.3: queries are generated from a DESCRIPTION
 * of the corpus, not the corpus itself. This prevents the eval set
 * from being trivially answerable by the retrieval system. Callers
 * should NOT pass full documents here.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_N_PERSONAS = 5;
const DEFAULT_QUERIES_PER_PERSONA = 3;

const PERSONA_SYSTEM = `You generate realistic USER PERSONAS for a RAG system. Given a short corpus description and a note about intended users, propose diverse personas who would plausibly use the system.

Reply with STRICT JSON:
{"personas": [{"role": "<job title or role>", "goal": "<what they want from the system>", "background": "<one sentence>"}, ...]}

Rules:
- Personas must be DIFFERENT — different roles, different goals, different backgrounds.
- Avoid obvious duplicates ("senior engineer" and "principal engineer" are one).
- Personas should match the intended-users note, but don't invent unrealistic edge cases.
- Max N personas; when in doubt, produce fewer-but-distinct over more-but-overlapping.`;

const QUERY_SYSTEM = `You generate SENSEMAKING QUESTIONS a persona would ask a RAG system about a corpus.

Sensemaking questions are GLOBAL — they ask about themes, trends, connections, comparisons across the whole corpus — NOT specific facts ("what does document X say?"). Good sensemaking questions:
  - "What are the main themes in how these papers treat X?"
  - "Which topics recur across the last six months of discussions?"
  - "What tensions or disagreements emerge in this dataset?"
Bad (too specific — these are vector-RAG queries, not sensemaking):
  - "When was X released?"
  - "What is the definition of Y in document Z?"

Reply with STRICT JSON:
{"questions": ["<q1>", "<q2>", ...]}

Rules:
- Write from the persona's voice; reflect their role + goal.
- Each question must be self-contained.
- Max M questions per persona. Prefer distinct angles over rephrased duplicates.`;

async function generatePersonas({
  openai, corpusDescription, intendedUsers = '', n = DEFAULT_N_PERSONAS, model = DEFAULT_MODEL,
}) {
  if (!openai) return [];
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.4, max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PERSONA_SYSTEM },
        {
          role: 'user',
          content: [
            `CORPUS DESCRIPTION (not the full corpus — a short summary):`,
            String(corpusDescription || '').slice(0, 3000),
            intendedUsers ? `INTENDED USERS: ${String(intendedUsers).slice(0, 500)}` : '',
            `Generate up to ${n} diverse personas.`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    return Array.isArray(parsed?.personas)
      ? parsed.personas.map(p => ({
          role: String(p?.role || '').slice(0, 100),
          goal: String(p?.goal || '').slice(0, 200),
          background: String(p?.background || '').slice(0, 300),
        })).filter(p => p.role && p.goal).slice(0, n)
      : [];
  } catch (err) {
    console.warn('[graphrag/adaptive-benchmark] personas failed:', err.message);
    return [];
  }
}

async function generateQueriesForPersona({
  openai, corpusDescription, persona, m = DEFAULT_QUERIES_PER_PERSONA, model = DEFAULT_MODEL,
}) {
  if (!openai || !persona?.role) return [];
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.4, max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: QUERY_SYSTEM },
        {
          role: 'user',
          content: [
            `CORPUS DESCRIPTION: ${String(corpusDescription || '').slice(0, 2000)}`,
            '',
            `PERSONA:`,
            `  role: ${persona.role}`,
            `  goal: ${persona.goal}`,
            `  background: ${persona.background || '(unspecified)'}`,
            '',
            `Generate up to ${m} sensemaking questions this persona would ask.`,
          ].join('\n'),
        },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    return Array.isArray(parsed?.questions)
      ? parsed.questions.map(q => String(q).slice(0, 300)).filter(Boolean).slice(0, m)
      : [];
  } catch (err) {
    console.warn('[graphrag/adaptive-benchmark] queries failed:', err.message);
    return [];
  }
}

/**
 * Generate a full persona-labeled query set.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.corpusDescription  — short summary (NOT the corpus itself)
 * @param {string} [args.intendedUsers]
 * @param {number} [args.nPersonas=5]
 * @param {number} [args.queriesPerPersona=3]
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   n_personas: number,
 *   n_queries: number,
 *   personas: [{...}],
 *   queries: [{persona_idx, role, question}, ...],
 * }>}
 */
async function generate({
  openai, corpusDescription, intendedUsers,
  nPersonas = DEFAULT_N_PERSONAS, queriesPerPersona = DEFAULT_QUERIES_PER_PERSONA,
  model = DEFAULT_MODEL,
}) {
  const personas = await generatePersonas({
    openai, corpusDescription, intendedUsers, n: nPersonas, model,
  });
  if (personas.length === 0) return { n_personas: 0, n_queries: 0, personas: [], queries: [] };

  const queries = [];
  for (let i = 0; i < personas.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const qs = await generateQueriesForPersona({
      openai, corpusDescription, persona: personas[i], m: queriesPerPersona, model,
    });
    for (const q of qs) {
      queries.push({ persona_idx: i, role: personas[i].role, question: q });
    }
  }

  return {
    n_personas: personas.length,
    n_queries: queries.length,
    personas,
    queries,
  };
}

module.exports = {
  generate,
  generatePersonas,
  generateQueriesForPersona,
  PERSONA_SYSTEM,
  QUERY_SYSTEM,
  DEFAULT_N_PERSONAS,
  DEFAULT_QUERIES_PER_PERSONA,
};
