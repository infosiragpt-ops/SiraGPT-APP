/**
 * synthesizer — turn validated sources into an APA 7-cited Marco
 * Teórico draft in the user's language.
 *
 * Contract (produced markdown structure):
 *   ## <topic>
 *   ### Introducción / Introduction
 *   <1-2 paragraphs>
 *   ### Ejes temáticos / Themes
 *   <3-6 thematic sub-sections with inline citations>
 *   ### Vacíos y tensiones / Gaps
 *   <1-2 paragraphs framing what's underexplored>
 *   ### Síntesis / Synthesis
 *   <1-2 paragraph closing>
 *   ## Referencias
 *   <APA 7 reference list>
 *
 * We pass sources into the prompt as a numbered block with key
 * fields (authors, year, title, abstract). The LLM cites via inline
 * parenthetical APA form. We DO NOT ask the LLM to write the
 * reference list — apa7.referenceList() generates it
 * deterministically from our structured metadata, so citations and
 * references stay consistent even if the model hallucinates.
 *
 * Streaming:
 *   - We use OpenAI chat.completions.create({ stream: true }) and
 *     yield chunks as they arrive. Caller is expected to be an
 *     async generator consumer (the route handler pipes chunks to
 *     SSE frames).
 */

const OpenAI = require('openai');
const apa7 = require('./apa7');

const DEFAULT_MODEL = 'gpt-4o';
const MAX_SOURCES_IN_PROMPT = 30;
const ABSTRACT_CAP = 1200;

function buildPrompt({ topic, description, sources, lang }) {
  const langName = lang === 'en' ? 'English' : 'Spanish';
  const asList = sources.slice(0, MAX_SOURCES_IN_PROMPT).map((s, i) => {
    const yr = s.year || 'n.d.';
    const auth = (s.authors || []).slice(0, 3).map(a => a.family || a.display).filter(Boolean).join(', ');
    const abs = s.abstract ? s.abstract.slice(0, ABSTRACT_CAP) : '(no abstract available)';
    return `[${i + 1}] ${auth || 'Anon.'} (${yr}). "${s.title || 'Untitled'}"${s.container ? ` — ${s.container}` : ''}\n    Abstract: ${abs}`;
  }).join('\n\n');

  return {
    system:
`You are a PhD-level research writer. Your task: produce a cohesive, well-argued theoretical framework (marco teórico) for an academic thesis using ONLY the sources provided.

Strict output contract:
- Reply in ${langName}.
- Output Markdown only.
- Structure, exactly these H3 sections in this order:
  ### Introducción
  ### Ejes temáticos
  ### Vacíos y tensiones
  ### Síntesis
- Do NOT include a "Referencias" / "References" heading — the reference list is appended deterministically after your output.
- In "Ejes temáticos", use 3-6 H4 subsections, each titled with a specific theme.
- Every substantive claim must be followed by an inline APA 7 citation in the form (Author, Year), (Author & Author, Year), or (Author et al., Year). Use ONLY the author names and years from the provided sources. Do not invent sources.
- You MAY cite multiple sources for one claim: (Smith, 2021; Jones & Lee, 2023).
- Prose should synthesise (link ideas across sources) rather than summarise (list what each said). Aim for ~800-1200 words total.
- Do not output bullet lists of sources — that's what the reference list is for.
- If fewer than 3 sources are supplied, produce a short honest "preliminary framework" with a note that the review is provisional.
`,
    user:
`Topic: ${topic}
${description ? `Context / Goal: ${description}\n` : ''}

Available sources (numbered; cite inline by first author + year as the APA form requires):

${asList}`,
  };
}

/**
 * Stream the synthesis as markdown chunks. Yields { delta: string }
 * shaped events as they arrive. When the stream ends, returns the
 * final full text (sans appended reference list).
 *
 * The caller is responsible for appending apa7.referenceList(sources)
 * once this generator completes.
 *
 * @param {object} openai — OpenAI client
 * @param {object} args
 * @param {string} args.topic
 * @param {string} [args.description]
 * @param {Array} args.sources — merged (openalex ∪ crossref) rows
 * @param {string} [args.lang='es']
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.model='gpt-4o']
 */
async function* streamMarkdown(openai, { topic, description, sources, lang = 'es', signal, model = DEFAULT_MODEL }) {
  if (!openai) throw new Error('synthesizer: openai required');
  if (!topic) throw new Error('synthesizer: topic required');

  const prompt = buildPrompt({ topic, description, sources, lang });

  const stream = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.3,
    max_tokens: 2400,
    stream: true,
  }, { signal });

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      full += delta;
      yield { delta, full };
    }
  }
  return full;
}

/**
 * Non-streaming convenience wrapper — useful for tests and one-shot
 * regeneration paths. Returns the full markdown string plus an
 * appended reference list built from `sources`.
 */
async function generate(openai, args) {
  let full = '';
  for await (const chunk of streamMarkdown(openai, args)) {
    full = chunk.full;
  }
  const refs = apa7.referenceList(args.sources || []);
  return `${full}\n\n## Referencias\n\n${refs}`;
}

module.exports = { streamMarkdown, generate, buildPrompt };
