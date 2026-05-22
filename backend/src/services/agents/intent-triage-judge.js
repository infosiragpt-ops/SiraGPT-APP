/**
 * intent-triage-judge — el LLM ligero que decide en la zona gris.
 *
 * Usa Gemini 2.5 Flash vía REST directo (sin SDK) porque sólo
 * necesitamos una llamada minúscula y queremos cero superficie de
 * dependencias adicional. La key se lee de `GEMINI_API_KEY`.
 *
 * Devuelve { action: 'execute' | 'ask', question?: string }
 *
 * Diseñado para inyectarse en `triageIntent` como el parámetro
 * `judge`. Si no hay key disponible, exportamos `null` y el caller
 * deja de pasar judge — el triage cae al fallback "execute".
 */

const SYSTEM = [
  "Eres un clasificador binario para Sira. Recibes el último mensaje del usuario y, si existe, un resumen mínimo de los últimos turnos.",
  "Tu único trabajo: decidir si la petición es suficientemente clara para ejecutarse directamente o si conviene hacer UNA sola pregunta breve antes de responder.",
  "",
  "Reglas:",
  "- Por defecto: action = execute. Sólo pide aclaración cuando ingenieros razonables producirían respuestas materialmente distintas según lo que asuman.",
  "- Si pides aclaración, escribe UNA sola pregunta corta en español natural, máximo una oración, terminada en '?'.",
  "- Nunca pidas más de una pregunta. Nunca añadas saludos ni explicaciones.",
  "- Si el usuario ya dio contexto suficiente o se refiere a algo del historial reciente, action = execute.",
  "",
  "Devuelve SÓLO JSON válido con esta forma exacta:",
  '{"action":"execute"} o {"action":"ask","question":"<una pregunta>"}',
].join("\n");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function buildUserBlock({ prompt, recentTurns, hintedQuestion }) {
  const lines = [];
  if (Array.isArray(recentTurns) && recentTurns.length > 0) {
    lines.push("HISTORIAL_RECIENTE:");
    for (const t of recentTurns) {
      const role = t?.role === "assistant" ? "assistant" : "user";
      const text = String(t?.text || "").replace(/\s+/g, " ").slice(0, 280);
      if (text) lines.push(`- ${role}: ${text}`);
    }
    lines.push("");
  }
  lines.push("MENSAJE_USUARIO:");
  lines.push(String(prompt || "").slice(0, 2000));
  if (hintedQuestion) {
    lines.push("");
    lines.push("SUGERENCIA_HEURÍSTICA (úsala sólo si decides ask):");
    lines.push(String(hintedQuestion).slice(0, 200));
  }
  return lines.join("\n");
}

function parseModelOutput(raw) {
  if (!raw || typeof raw !== "string") return { action: "execute" };
  let txt = raw.trim();
  // Strip Markdown fences if the model wraps the JSON.
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) txt = fence[1].trim();
  try {
    const obj = JSON.parse(txt);
    if (obj && obj.action === "ask" && typeof obj.question === "string") {
      return { action: "ask", question: obj.question };
    }
    return { action: "execute" };
  } catch {
    return { action: "execute" };
  }
}

function makeGeminiJudge({ apiKey = process.env.GEMINI_API_KEY, fetchImpl = global.fetch } = {}) {
  if (!apiKey || typeof fetchImpl !== "function") return null;
  return async function geminiJudge({ prompt, recentTurns, hintedQuestion }) {
    const body = {
      systemInstruction: { role: "system", parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserBlock({ prompt, recentTurns, hintedQuestion }) }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 120,
        responseMimeType: "application/json",
      },
    };
    const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`gemini_http_${resp.status}`);
    }
    const data = await resp.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return parseModelOutput(text);
  };
}

module.exports = {
  makeGeminiJudge,
  parseModelOutput,
  buildUserBlock,
  SYSTEM,
};
