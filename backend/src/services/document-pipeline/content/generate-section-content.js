const { createContentClient, DEFAULT_MODEL } = require('./llm-client');
const { SECTION_CONTENT_SCHEMA, buildSystemPrompt, buildUserPrompt } = require('./prompts');

const REQUEST_TIMEOUT_MS = 25_000;

// Hard fallback when the LLM call fails or the API key isn't provisioned.
// This is intentionally not the original "Bloque N generado por la
// pipeline documental..." placeholder — that was the bug. This fallback
// is per-section and clearly signals degraded mode without copy-pasting
// the same string across slides.
function fallbackBlock(sectionName) {
  return {
    section: sectionName,
    paragraph: `Sección "${sectionName}" — el generador automático de contenido no estuvo disponible para este intento. El esqueleto y el formato del documento están listos; relanza la generación o edita esta sección manualmente para añadir el contenido específico.`,
    bullets: [
      'Esqueleto y maquetación generados correctamente',
      'Validaciones técnicas del archivo aprobadas',
      'Contenido específico pendiente de regeneración',
    ],
    notes: 'El generador de contenido por LLM no respondió en este intento. Recomendable reintentar.',
  };
}

// Returns one block per section in plan.sections, in the same order.
// Calls run in parallel because sections are independent — the slowest
// response dominates total latency, not the sum.
async function generateSectionContent({
  prompt,
  plan,
  signal,
  language,
  provider = 'OpenAI',
  model = DEFAULT_MODEL,
} = {}) {
  if (!plan || !Array.isArray(plan.sections) || plan.sections.length === 0) {
    return [];
  }

  // Skip the LLM round-trip entirely when no key is configured. The
  // pipeline still produces a well-formed file; the fallback content
  // makes the degradation visible instead of pretending success.
  const hasKey =
    provider === 'OpenAI' ? !!process.env.OPENAI_API_KEY :
    provider === 'Gemini' ? !!process.env.GEMINI_API_KEY :
    provider === 'DeepSeek' ? !!process.env.DEEPSEEK_API_KEY :
    provider === 'OpenRouter' ? !!process.env.OPENROUTER_API_KEY :
    false;
  if (!hasKey) {
    return plan.sections.map((section) => fallbackBlock(section));
  }

  const client = createContentClient(provider);
  const systemPrompt = buildSystemPrompt({ language, template: plan.template });

  const tasks = plan.sections.map(async (section) => {
    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: buildUserPrompt({
              userRequest: prompt,
              documentTitle: plan.title,
              sectionName: section,
              language,
            }),
          },
        ],
        response_format: { type: 'json_schema', json_schema: SECTION_CONTENT_SCHEMA },
        temperature: 0.4,
      }, { signal, timeout: REQUEST_TIMEOUT_MS });

      const raw = completion?.choices?.[0]?.message?.content;
      if (!raw) return fallbackBlock(section);
      const parsed = JSON.parse(raw);
      return {
        section,
        paragraph: String(parsed.paragraph || '').trim() || fallbackBlock(section).paragraph,
        bullets: Array.isArray(parsed.bullets) && parsed.bullets.length > 0
          ? parsed.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 5)
          : fallbackBlock(section).bullets,
        notes: String(parsed.notes || '').trim() || fallbackBlock(section).notes,
      };
    } catch (err) {
      // One section failing should not poison the whole presentation.
      // We swallow + fall back to the per-section graceful payload and
      // let the caller emit a single warning event.
      return { ...fallbackBlock(section), _error: err.message || String(err) };
    }
  });

  return Promise.all(tasks);
}

module.exports = { generateSectionContent, fallbackBlock };
