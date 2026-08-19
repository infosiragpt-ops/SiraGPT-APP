/**
 * math-solver — natural-language → rigorous math/science answer.
 *
 * Pipeline:
 *   1. Provider-routed LLM call with a math-specialised system prompt
 *      that instructs the model to return ONE JSON object with:
 *        · explanation : markdown with LaTeX ($...$ inline / $$...$$
 *                         block) explaining the steps
 *        · python      : self-contained Python 3 source that, when
 *                         executed, prints the numeric/symbolic
 *                         verification. May be empty for pure
 *                         algebraic problems.
 *        · answer_latex: the final answer as a LaTeX string, ready
 *                         for $$...$$ embedding
 *        · topic       : 'algebra' | 'calculus' | 'statistics' |
 *                         'linear_algebra' | 'probability' |
 *                         'physics' | 'chemistry' | 'other'
 *   2. If `python` is non-empty, run it in the sandbox (SymPy / NumPy
 *      / SciPy / Pandas available on the host). Prepend `import sympy
 *      as sp; import numpy as np; import scipy; import pandas as pd`
 *      so the LLM can stop worrying about imports.
 *   3. Stitch the pieces into a single markdown message the front-end
 *      renders with remark-math + rehype-katex already wired:
 *
 *        # <Topic badge>
 *        Explicación en español con LaTeX.
 *        $$ answer_latex $$
 *        <details>Cálculo con Python · SymPy / NumPy / SciPy / Pandas</details>
 *
 *   4. Returns `{ assistantMessage, usedPython, runtimeMs }` so the
 *      route handler can persist and respond.
 *
 * Why not just pure LLM: numerical integrals, eigenvalues, Cronbach's
 * alpha on a real data vector, and anything involving large matrices
 * are unreliable from the language model alone. Running SymPy/NumPy
 * anchors the answer to actual computation; the LLM stays as the
 * teacher explaining the steps.
 */

const OpenAI = require('openai');
const { run } = require('./agents/code-sandbox');

// Provider routing — same pattern as design-generator / plan-generator.
function clientForModel(modelName) {
  if (!modelName) return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
  const m = String(modelName);
  if (/^deepseek-(v\d|chat|reasoner)/i.test(m.trim())) {
    return {
      provider: 'DeepSeek',
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      }),
    };
  }
  if (/^(anthropic|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|google|moonshotai)\//i.test(m)
      || m.includes('/gpt-oss')) {
    return {
      provider: 'OpenRouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    };
  }
  if (m.includes('gemini')) {
    return {
      provider: 'Gemini',
      client: new OpenAI({
        apiKey: process.env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      }),
    };
  }
  return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
}

const SYSTEM_PROMPT = `You are a senior mathematics / science tutor for the siraGPT assistant.

Your output MUST be a single JSON object with these fields:
{
  "topic": "algebra" | "calculus" | "statistics" | "linear_algebra" | "probability" | "physics" | "chemistry" | "other",
  "explanation": string,   // markdown in the user's language (Spanish by default). Explain the approach step by step. Use LaTeX: $inline$ for short formulas, $$display$$ for standalone equations. Keep it concise — 3-6 short paragraphs or a numbered list of steps.
  "python": string,        // optional. Python 3 source that verifies/solves the problem numerically or symbolically. Leave as empty string "" when the problem is purely qualitative or the math is obviously trivial. Available libs on the sandbox: sympy, numpy, scipy, pandas (plus the full stdlib). You MUST import each library yourself at the top of the snippet — only import what you actually use (importing all of pandas + scipy adds ~30 s startup). Prefer: import sympy as sp, import numpy as np. Print the final answer with print(). Must complete in under 15 seconds.
  "answer_latex": string   // the final answer as a clean LaTeX expression (no \\[ \\] wrappers, just the math). Example: "\\\\int x^2 \\\\sin(x)\\\\,dx = -x^2\\\\cos(x) + 2x\\\\sin(x) + 2\\\\cos(x) + C".
}

Rules:
- Always respond in the user's language. Default to Spanish if unclear.
- LaTeX inside JSON strings must have backslashes escaped (\\\\int, \\\\alpha, \\\\frac{a}{b}).
- The explanation must be pedagogical — show the reasoning, don't just state the answer.
- When Python is appropriate (numeric integration, statistics on data, matrix ops, Cronbach's alpha, chi-square, regression, physics simulations), ALWAYS include it. Prefer SymPy for symbolic work, NumPy/SciPy/Pandas for numeric/data work.
- For statistics, report the formula used, sample size, assumptions, and a short interpretation of the numeric result. If the provided data is too small or malformed, say so explicitly instead of over-claiming.
- For psychometrics (Cronbach, Spearman, Likert instruments), show the computation path and interpret reliability/correlation conservatively. Do not invent missing rows or answers.
- For physics/chemistry/science exam problems, define variables, units, governing equation, substitution, final answer, and a quick dimensional sanity check.
- Python code must be SELF-CONTAINED: all data needed to compute the answer should be embedded in the source. If the user pasted tabular data, put it into a pandas.DataFrame literal at the top of the code.
- Keep Python short (<60 lines). Don't define functions unless necessary. End with one or more print(...) statements showing the result clearly.
- In print strings, use DOUBLE quotes for the outer string (print("...")) and avoid apostrophes inside them to prevent syntax errors. If you need an apostrophe, write it as \\' or rephrase the label.
- Return ONLY valid JSON. No prose before or after, no markdown fences around the JSON.
- If the user's prompt is NOT a math/science problem (it's a greeting, off-topic chat, etc.), return {"topic":"other","explanation":"...","python":"","answer_latex":""} with a gentle note redirecting them.

Examples of when to fill "python":
- "Calcula la integral de x^2·sin(x) dx" → SymPy integrate
- "Cronbach's alpha for [[4,5,3],[5,5,4],[4,4,3],[5,5,5]]" → NumPy / custom formula
- "Autovalores de [[2,1],[1,3]]" → NumPy eigvals
- "Probabilidad binomial n=10, p=0.3, k=4" → scipy.stats.binom

Return exactly ONE JSON object.`;

// Minimal prelude — stdlib only, ~0 ms cost. Scientific libs are
// imported by the LLM-generated snippet on demand because eager
// imports of scipy.stats / pandas add 30+ seconds to cold startup.
const PY_HEADER = `import math, statistics, itertools, fractions, decimal, json as _json\n`;

function extractJson(raw) {
  if (!raw) throw new Error('empty response');
  const candidates = [raw];
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  candidates.push(stripped);
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1));
  let lastErr;
  for (const c of candidates) {
    try { return JSON.parse(c); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`JSON parse failed: ${lastErr?.message}`);
}

async function solveMath({ prompt, model, signal }) {
  const routed = clientForModel(model);
  if (!routed.client) throw new Error(`math-solver: no API key for "${model}"`);

  const callModel = async (useJsonMode) => {
    const params = {
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 3000,
    };
    if (useJsonMode && routed.provider !== 'Gemini') {
      params.response_format = { type: 'json_object' };
    }
    return routed.client.chat.completions.create(params, { signal });
  };

  let resp;
  try {
    resp = await callModel(true);
  } catch (err) {
    if (/response_format|json_object|invalid.*param/i.test(err?.message || '')) {
      resp = await callModel(false);
    } else {
      throw err;
    }
  }

  const raw = resp.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw);

  let usedPython = false;
  let runtimeMs = 0;
  let pythonStdout = '';
  let pythonStderr = '';
  let pythonTimedOut = false;

  if (parsed.python && typeof parsed.python === 'string' && parsed.python.trim().length > 0) {
    usedPython = true;
    const source = PY_HEADER + parsed.python;
    const t0 = Date.now();
    const result = await run({
      language: 'python',
      source,
      timeoutMs: 15_000,
    });
    runtimeMs = Date.now() - t0;
    pythonStdout = (result.stdout || '').trim();
    pythonStderr = (result.stderr || '').trim();
    pythonTimedOut = !!result.timedOut;
  }

  // Compose the assistant-facing markdown message.
  const topicLabel = {
    algebra: 'Álgebra',
    calculus: 'Cálculo',
    statistics: 'Estadística',
    linear_algebra: 'Álgebra lineal',
    probability: 'Probabilidad',
    physics: 'Física',
    chemistry: 'Química',
    other: 'Matemáticas',
  }[parsed.topic] || 'Matemáticas';

  const parts = [];
  parts.push(`**${topicLabel}**`);
  parts.push('');
  if (parsed.explanation) parts.push(parsed.explanation.trim());
  if (parsed.answer_latex && parsed.answer_latex.trim()) {
    parts.push('');
    parts.push(`$$${parsed.answer_latex.trim()}$$`);
  }
  if (usedPython) {
    parts.push('');
    parts.push('<details>');
    parts.push(`<summary>Verificación numérica · Python (SymPy / NumPy / SciPy / Pandas) · ${runtimeMs} ms</summary>`);
    parts.push('');
    parts.push('```python');
    parts.push(parsed.python.trim());
    parts.push('```');
    if (pythonStdout) {
      parts.push('');
      parts.push('**Salida:**');
      parts.push('```');
      parts.push(pythonStdout);
      parts.push('```');
    }
    if (pythonStderr && !pythonStdout) {
      parts.push('');
      parts.push('**Error:**');
      parts.push('```');
      parts.push(pythonStderr);
      parts.push('```');
    }
    if (pythonTimedOut) {
      parts.push('');
      parts.push('_⚠ Ejecución interrumpida por timeout (10 s)._');
    }
    parts.push('</details>');
  }

  return {
    content: parts.join('\n'),
    topic: parsed.topic || 'other',
    usedPython,
    runtimeMs,
    pythonStdout,
    pythonStderr,
    pythonTimedOut,
    raw: parsed,
  };
}

// Streaming variant — yields progress events for the SSE route so the
// chat can render live stages instead of a silent 15 s spinner.
async function* streamSolve({ prompt, model, signal }) {
  yield { type: 'stage', label: 'Analizando el problema', pct: 5 };
  const routed = clientForModel(model);
  if (!routed.client) {
    yield { type: 'error', error: `Sin API key para "${model}"` };
    return;
  }
  yield { type: 'stage', label: `Consultando modelo (${routed.provider})`, pct: 15 };

  let result;
  try {
    result = await solveMath({ prompt, model, signal });
  } catch (err) {
    if (err?.name === 'AbortError') { yield { type: 'error', error: 'aborted' }; return; }
    yield { type: 'error', error: err?.message || 'math-solver failed' };
    return;
  }

  if (result.usedPython) {
    yield { type: 'stage', label: `Ejecutado Python en ${result.runtimeMs} ms`, pct: 85 };
  }
  yield { type: 'stage', label: 'Formateando respuesta con LaTeX', pct: 95 };
  yield { type: 'final', content: result.content, topic: result.topic, usedPython: result.usedPython };
}

module.exports = { solveMath, streamSolve, clientForModel };
