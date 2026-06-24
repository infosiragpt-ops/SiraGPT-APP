/**
 * code-intake-question — LLM-generated, context-aware intake questions for the
 * /code agent. Replaces the hardcoded question for a given slot with one phrased
 * by the model based on what the user already said, so the interview feels like
 * the AI is actually listening. Always degrades to the caller's static fallback
 * (no key / LLM down / bad output) so the intake never blocks.
 */

const llm = require('./builder/llm');

const SLOT_HINT = {
  productType: 'qué producto o servicio va a ofrecer',
  brand: 'el nombre de su marca o negocio (o si quiere que se proponga uno)',
  styleAudience: 'el estilo visual y el público objetivo',
  sections: 'qué secciones quiere en la página',
  colorRef: 'colores, paleta o referencias visuales que le gusten',
  features: 'qué funcionalidades clave no pueden faltar',
  dataEntities: 'qué datos o entidades manejará la app',
};

async function generateCodeIntakeQuestion({ slot, history = [], fallback = '', env = process.env } = {}) {
  const hint = SLOT_HINT[slot];
  const safe = fallback || (hint ? `¿Puedes contarme sobre ${hint}?` : '¿Algún detalle más sobre tu idea?');
  if (!hint || !llm.isLlmAvailable || !llm.isLlmAvailable({ env })) return safe;

  try {
    const convo = (Array.isArray(history) ? history : [])
      .slice(-8)
      .map((t) => {
        const who = t && t.role === 'assistant' ? 'IA' : 'Usuario';
        return `${who}: ${String((t && t.content) || '').slice(0, 400)}`;
      })
      .join('\n');

    const system =
      'Eres un product manager senior entrevistando a un usuario para construir su web o app. ' +
      'Haz UNA sola pregunta, breve y muy concreta, en español, sobre la dimensión indicada — ' +
      'adaptada a lo que el usuario ya dijo (menciona su producto, marca o rubro si ayuda a que se sienta personal). ' +
      'Si conviene, sugiere 2-3 opciones entre paréntesis. Devuelve SOLO la pregunta: sin preámbulo, sin comillas, sin explicación.';
    const user = `Conversación hasta ahora:\n${convo || '(aún nada)'}\n\nPregúntale por: ${hint}.\nTu pregunta:`;

    // gpt-oss-120b (current Cerebras free model) is a reasoning model: it spends
    // tokens thinking before the answer, so a tiny budget yields empty content.
    // Give it room (the question itself is short; it stops early once written).
    const out = await llm.complete({ system, user, env, temperature: 0.6, maxTokens: 800, timeoutMs: 15000 });
    let q = String(out || '').trim().split('\n')[0].replace(/^["'¿\s]+/, '').replace(/["'\s]+$/, '').trim();
    if (q && q.length >= 5 && q.length <= 240) {
      if (!q.startsWith('¿')) q = `¿${q}`;
      if (!/[?¿]$/.test(q)) q = `${q}?`;
      return q;
    }
    return safe;
  } catch {
    return safe;
  }
}

module.exports = { generateCodeIntakeQuestion, SLOT_HINT };
