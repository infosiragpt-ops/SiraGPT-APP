#!/usr/bin/env node
'use strict';

/**
 * Harness v2 live smoke test (opt-in, costs a few cents per model).
 *
 *   node scripts/harness-v2-smoke.cjs --provider Anthropic --model claude-fable-5-1 [--effort high] [--mode auto|native|prompted]
 *   node scripts/harness-v2-smoke.cjs --matrix     # the default five-provider matrix
 *
 * Runs a real two-tool task (get_time + calculator) through the new loop
 * and prints ONE JSON line per model: pass/fail, steps, tool calls, time
 * to first token and total latency. Never prints keys or prompts.
 * Inside the prod backend container, provider keys saved in Admin →
 * Conexiones are loaded first (admin-connections bridge) when a database
 * URL is available.
 */

const path = require('path');

const MATRIX = [
  { provider: 'Anthropic', model: 'claude-fable-5-1' },
  { provider: 'xAI', model: 'grok-4-fast' },
  { provider: 'Meta', model: 'muse-spark-1.2' },
  { provider: 'DeepSeek', model: 'deepseek-v4-flash' },
  { provider: 'Gemini', model: 'gemini-2.5-flash' },
];

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

// Tiny arithmetic evaluator: numbers, + - * / ^, parentheses. No eval().
function evaluate(expression) {
  const src = String(expression).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
  let i = 0;
  const peek = () => src[i];
  function number() {
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`expresión inválida cerca de "${src.slice(i, i + 8)}"`);
    i += m[0].length;
    return Number(m[0]);
  }
  function factor() {
    if (peek() === '-') { i += 1; return -factor(); }
    if (peek() === '(') { i += 1; const v = expr(); if (peek() !== ')') throw new Error('falta ")"'); i += 1; return v; }
    return number();
  }
  function power() { let v = factor(); while (peek() === '^') { i += 1; v **= factor(); } return v; }
  function term() { let v = power(); while (peek() === '*' || peek() === '/') { const op = src[i]; i += 1; const r = power(); v = op === '*' ? v * r : v / r; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = src[i]; i += 1; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  const value = expr();
  if (i !== src.length) throw new Error(`carácter inesperado "${src[i]}"`);
  return value;
}

const TOOLS = [
  {
    name: 'get_time',
    description: 'Devuelve la fecha y hora actual en una zona horaria IANA (por ejemplo America/Lima).',
    input_schema: { type: 'object', properties: { timezone: { type: 'string', description: 'Zona horaria IANA' } }, required: ['timezone'], additionalProperties: false },
    parallelSafe: true,
    run: ({ timezone }) => {
      const now = new Date();
      const local = new Intl.DateTimeFormat('es-PE', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now);
      return { timezone, local, iso: now.toISOString() };
    },
  },
  {
    name: 'calculator',
    description: 'Evalúa una expresión aritmética (+, -, *, /, ^, paréntesis) y devuelve el resultado exacto.',
    input_schema: { type: 'object', properties: { expression: { type: 'string', description: 'Expresión, por ejemplo 17*23' } }, required: ['expression'], additionalProperties: false },
    parallelSafe: true,
    run: ({ expression }) => ({ expression, result: evaluate(expression) }),
  },
];

const TASK = 'Usa la herramienta get_time para saber la hora actual en America/Lima y la herramienta calculator para calcular 17*23. Luego responde en una sola frase con la hora y el resultado.';

async function loadAdminKeys() {
  if (!process.env.DATABASE_URL && process.env.PRISMA_DATABASE_URL) process.env.DATABASE_URL = process.env.PRISMA_DATABASE_URL;
  if (!process.env.DATABASE_URL) return false;
  try {
    const { applyAdminConnections } = require(path.join(__dirname, '../src/services/admin-connections-bridge'));
    await applyAdminConnections();
    return true;
  } catch (err) {
    process.stderr.write(`[smoke] admin connections not loaded: ${err.message}\n`);
    return false;
  }
}

async function runOne({ provider, model, effort, mode }) {
  const { runHarness } = require(path.join(__dirname, '../src/services/harness'));
  const toolsUsed = [];
  const startedAt = Date.now();
  const result = await runHarness({
    provider,
    model,
    toolMode: mode || 'auto',
    system: 'Eres un asistente preciso. Usa las herramientas disponibles cuando la tarea lo pida y responde en español.',
    messages: [{ role: 'user', content: TASK }],
    tools: TOOLS,
    effort: effort ? { level: effort, explicit: true } : {},
    maxTokens: 4096,
    maxSteps: 6,
    retry: { maxRetries: 2 },
    onEvent: (ev) => { if (ev.type === 'tool_result') toolsUsed.push(`${ev.name}${ev.isError ? ':error' : ''}`); },
  }).catch((err) => ({ stopReason: 'error', error: err, finalText: '' }));
  const finalText = String(result.finalText || '');
  const ok = result.stopReason === 'end_turn'
    && toolsUsed.some((t) => t === 'get_time') && toolsUsed.some((t) => t === 'calculator')
    && /391/.test(finalText.replace(/[.,\s]/g, ''));
  return {
    provider,
    model,
    toolMode: result.toolMode || null,
    ok,
    stopReason: result.stopReason,
    steps: result.steps || 0,
    toolCalls: toolsUsed,
    firstTokenMs: result.firstTokenMs ?? null,
    latencyMs: Date.now() - startedAt,
    usage: result.usage || null,
    answer: finalText.slice(0, 240),
    error: result.error ? String(result.error.message || result.error).slice(0, 300) : null,
  };
}

async function main() {
  const a = args();
  await loadAdminKeys();
  const targets = a.matrix ? MATRIX : [{ provider: a.provider, model: a.model }];
  if (!targets[0].provider || !targets[0].model) {
    process.stderr.write('usage: harness-v2-smoke.cjs --provider <P> --model <M> [--effort level] [--mode auto|native|prompted] | --matrix\n');
    process.exit(2);
  }
  let failures = 0;
  for (const t of targets) {
    const row = await runOne({ ...t, effort: a.effort, mode: a.mode });
    if (!row.ok) failures += 1;
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
  process.exit(failures ? 1 : 0);
}

if (require.main === module) main();

module.exports = { evaluate, TOOLS };
