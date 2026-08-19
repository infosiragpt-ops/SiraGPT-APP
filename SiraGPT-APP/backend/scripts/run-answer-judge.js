#!/usr/bin/env node
'use strict';

/**
 * run-answer-judge.js — independent LLM judge over the live-chat E2E answers.
 * Reads evals/judge-items.json ({id,turn,category,prompt,expected,fact,answer,
 * infra}) and asks gpt-4o-mini to rule each real answer CORRECT/INCORRECT vs
 * the planted ground-truth (infra items are excluded — they're tool/loop
 * failures, reported separately). Aggregates a trustworthy capability rate.
 */

const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}

const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.JUDGE_MODEL || 'gpt-4o-mini';

const items = require(path.join(__dirname, '..', 'evals', 'judge-items.json'));
const real = items.filter((x) => !x.infra);
const infra = items.filter((x) => x.infra);

async function judge(it) {
  const sys = 'Eres un evaluador estricto e independiente. Decides si la RESPUESTA del asistente contesta correctamente la PREGUNTA según la VERDAD del documento. Una respuesta verbosa que contiene el valor correcto cuenta como correcta. Un número/nombre equivocado, una negativa, o una respuesta sobre OTRO documento es incorrecta. Para preguntas de cálculo (diferencia, promedio, porcentaje) debe mostrar el valor calculado. Responde EXACTAMENTE con "CORRECT" o "INCORRECT" seguido de "|" y una razón breve.';
  const user = `PREGUNTA: ${it.prompt}\nVERDAD DEL DOCUMENTO: ${it.fact}\nVALORES ACEPTABLES: ${JSON.stringify(it.expected)}\nRESPUESTA DEL ASISTENTE: ${it.answer}`;
  try {
    const r = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0, max_tokens: 120,
    });
    const out = (r.choices?.[0]?.message?.content || '').trim();
    const correct = /^correct\b/i.test(out);
    return { ...it, verdict: correct ? 'correct' : 'incorrect', reason: out.split('|').slice(1).join('|').trim().slice(0, 120) };
  } catch (e) {
    return { ...it, verdict: 'error', reason: e.message.slice(0, 120) };
  }
}

async function pool(arr, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx]); }
  }));
  return out;
}

(async () => {
  process.stdout.write(`▶ judging ${real.length} real answers with ${MODEL} (${infra.length} infra excluded)…\n`);
  const verdicts = await pool(real, 6, judge);
  const cats = {};
  let correct = 0, incorrect = 0, err = 0;
  for (const v of verdicts) {
    const c = cats[v.category] || (cats[v.category] = { correct: 0, incorrect: 0, total: 0 });
    c.total++;
    if (v.verdict === 'correct') { correct++; c.correct++; }
    else if (v.verdict === 'incorrect') { incorrect++; c.incorrect++; }
    else err++;
    const m = v.verdict === 'correct' ? '✅' : (v.verdict === 'error' ? '⚠️' : '❌');
    process.stdout.write(`  ${m} ${v.id}${v.turn ? '#' + v.turn : ''} [${v.category}] ${v.reason}\n`);
  }
  const answered = correct + incorrect;
  process.stdout.write('\n═══ Judge summary ═══\n');
  for (const [c, s] of Object.entries(cats)) {
    process.stdout.write(`  ${c.padEnd(12)} ${s.correct}/${s.total} (${Math.round((s.correct / s.total) * 100)}%)\n`);
  }
  process.stdout.write(`  capability (correct/answered): ${correct}/${answered} (${Math.round((correct / answered) * 100)}%)\n`);
  process.stdout.write(`  infra failures excluded: ${infra.length} | judge errors: ${err}\n`);
  fs.writeFileSync(path.join(__dirname, '..', 'evals', 'judge-verdicts.json'),
    JSON.stringify({ model: MODEL, correct, incorrect, infraExcluded: infra.length, byCategory: cats, verdicts, infra: infra.map((x) => ({ id: x.id, turn: x.turn, category: x.category, answer: x.answer.slice(0, 80) })) }, null, 2));
  process.stdout.write('\n📄 evals/judge-verdicts.json\n');
})();
