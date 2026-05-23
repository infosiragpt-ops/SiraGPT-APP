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

// ─── Coreference resolver judge (reuses Gemini Flash) ───────────────
// Mismo modelo, distinto system prompt. Reusa el mismo costo/quota.
// Output: { resolvesTo: string, confidence: 0..1 } o { resolvesTo: null }
// cuando no logra anclar el referente.

const COREF_SYSTEM = [
  "Eres un resolvedor de coreferencias para Sira. Recibes los últimos turnos de una conversación y un mensaje nuevo del usuario que contiene un pronombre o referencia deíctica ('eso', 'el anterior', 'la segunda parte', 'mi CV').",
  "Tu único trabajo: determinar a qué se refiere el pronombre o referencia, citando el referente del historial. Si no logras anclar con confianza, devuelve null.",
  "",
  "Reglas:",
  "- Cita el referente como una frase corta tomada del historial (máximo 120 chars).",
  "- confidence en [0.0, 1.0]: 0.9+ cuando es obvio, 0.6-0.8 cuando es probable, <0.6 cuando es ambiguo.",
  "- Si el referente es un adjunto (archivo/imagen subida), descríbelo (ej. 'el PDF de macroeconomía adjunto').",
  "- NUNCA inventes contenido que no esté en el historial.",
  "- Si no puedes resolver con confianza >= 0.5, devuelve {\"resolvesTo\": null, \"confidence\": 0}.",
  "",
  "Devuelve SÓLO JSON válido con la forma exacta:",
  '{"resolvesTo":"<frase corta>","confidence":<0..1>} o {"resolvesTo":null,"confidence":0}',
].join("\n");

function buildCorefUserBlock({ anaphor, prompt, recentTurns, attachments }) {
  const lines = [];
  if (Array.isArray(recentTurns) && recentTurns.length > 0) {
    lines.push("HISTORIAL_RECIENTE:");
    for (const t of recentTurns) {
      const role = t?.role === "assistant" ? "assistant" : "user";
      const text = String(t?.text || t?.content || "").replace(/\s+/g, " ").slice(0, 400);
      if (text) lines.push(`- ${role}: ${text}`);
    }
    lines.push("");
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    lines.push("ADJUNTOS_DISPONIBLES:");
    for (const a of attachments) {
      const desc = String(a?.name || a?.filename || a?.id || "adjunto").slice(0, 120);
      lines.push(`- ${desc}`);
    }
    lines.push("");
  }
  lines.push("MENSAJE_NUEVO:");
  lines.push(String(prompt || "").slice(0, 1000));
  lines.push("");
  lines.push(`ANAFORA_DETECTADA: "${String(anaphor || "").slice(0, 80)}"`);
  return lines.join("\n");
}

function parseCorefOutput(raw) {
  if (!raw || typeof raw !== "string") return { resolvesTo: null, confidence: 0 };
  let txt = raw.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) txt = fence[1].trim();
  try {
    const obj = JSON.parse(txt);
    if (obj && obj.resolvesTo && typeof obj.resolvesTo === "string") {
      const conf = Number(obj.confidence);
      return {
        resolvesTo: String(obj.resolvesTo).slice(0, 200),
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      };
    }
    return { resolvesTo: null, confidence: 0 };
  } catch {
    return { resolvesTo: null, confidence: 0 };
  }
}

function makeGeminiCorefJudge({ apiKey = process.env.GEMINI_API_KEY, fetchImpl = global.fetch } = {}) {
  if (!apiKey || typeof fetchImpl !== "function") return null;
  return async function corefJudge({ anaphor, prompt, recentTurns, attachments }) {
    const body = {
      systemInstruction: { role: "system", parts: [{ text: COREF_SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: buildCorefUserBlock({ anaphor, prompt, recentTurns, attachments }) }],
        },
      ],
      generationConfig: {
        temperature: 0.05,
        maxOutputTokens: 200,
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
    return parseCorefOutput(text);
  };
}

module.exports = {
  makeGeminiJudge,
  parseModelOutput,
  buildUserBlock,
  SYSTEM,
  // PR-3: coref judge
  makeGeminiCorefJudge,
  parseCorefOutput,
  buildCorefUserBlock,
  COREF_SYSTEM,
};
