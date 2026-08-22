'use strict';

/**
 * Visual verify loop — SOLO DeepSeek V4 Flash / Pro (cliente existente).
 * OpenRouter está prohibido en este motor. No se inventan API keys:
 * si falta DEEPSEEK_API_KEY el verify se omite con log estructurado.
 */

const fs = require('fs');
const path = require('path');
const { getDocEngineConfig } = require('./flags');
const { parseClosedDsl, looksLikeXmlOrCode } = require('./visual-dsl');

function createDeepSeekClient(env = process.env, OpenAIImpl) {
  const key = String(env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return null;
  const OpenAI = OpenAIImpl || require('openai');
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.deepseek.com',
  });
}

function pickDeepSeekModel({ preferPro = false, env = process.env } = {}) {
  const cfg = getDocEngineConfig(env);
  return preferPro ? cfg.deepseekProModel : cfg.deepseekFlashModel;
}

function encodeImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return { mime, b64: buf.toString('base64') };
}

/**
 * @param {{ pages: string[], instructions?: string, jobId?: string }} opts
 * @param {{ client?, env?, fetchComplete? }} deps  inyectables para tests
 */
async function runVerifyLoop(opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const cfg = getDocEngineConfig(env);
  const pages = Array.isArray(opts.pages) ? opts.pages.filter((p) => p && fs.existsSync(p)) : [];
  const maxIter = Math.min(3, cfg.maxVerifyIterations);
  const tokenBudget = cfg.verifyMaxTokens;
  const log = [];

  const client = deps.client !== undefined ? deps.client : createDeepSeekClient(env, deps.OpenAI);
  if (!client) {
    const entry = {
      jobId: opts.jobId || null,
      iteration: 0,
      skipped: true,
      reason: 'DEEPSEEK_API_KEY missing — verify omitted (no invented keys)',
      model: null,
      tokens: 0,
    };
    log.push(entry);
    return { ok: true, skipped: true, iterations: 0, log };
  }

  let remainingTokens = tokenBudget * maxIter;
  let last = { ok: true, placeholdersVisible: false };
  for (let i = 1; i <= maxIter; i += 1) {
    if (remainingTokens <= 0) {
      log.push({
        jobId: opts.jobId || null,
        iteration: i,
        cut: true,
        reason: 'token budget cut',
        remainingTokens: 0,
      });
      break;
    }
    const model = pickDeepSeekModel({ preferPro: i === maxIter, env });
    const maxTokens = Math.min(cfg.verifyMaxTokens, remainingTokens);
    const content = [
      {
        type: 'text',
        text: [
          'Eres el verificador visual de SiraGPT (Luis Carrera).',
          'El DOCX debe mostrar el CONTENIDO FUENTE transplantado a la plantilla.',
          'Si ves placeholders XXXXXXXX o una plantilla vacía, ok=false.',
          'Responde SOLO JSON cerrado (sin XML, sin código, sin markdown):',
          '{"ok":true|false,"placeholdersVisible":bool,"issues":[],"ops":[]}',
          'ops es un DSL cerrado: replace_text{find,replace} o set_style{styleId,textEquals}.',
          'NUNCA emitas XML, w:p, document.xml, Python ni JavaScript.',
          opts.instructions ? `Instrucción del usuario: ${String(opts.instructions).slice(0, 500)}` : '',
        ].filter(Boolean).join('\n'),
      },
    ];
    for (const page of pages.slice(0, 4)) {
      try {
        const img = encodeImage(page);
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.b64}` },
        });
      } catch {
        /* skip unreadable page */
      }
    }

    const started = Date.now();
    let text = '';
    try {
      const complete = deps.fetchComplete || ((body) => client.chat.completions.create(body));
      const res = await complete({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      });
      text = res?.choices?.[0]?.message?.content || '';
      const used = Number(res?.usage?.total_tokens) || maxTokens;
      remainingTokens -= used;
      if (looksLikeXmlOrCode(text)) {
        log.push({
          jobId: opts.jobId || null,
          iteration: i,
          model,
          rejected: true,
          reason: 'model emitted XML/code — closed DSL only',
        });
        last = { ok: false, placeholdersVisible: true, issues: ['xml_or_code_rejected'], ops: [] };
        continue;
      }
      last = parseVerdict(text);
      log.push({
        jobId: opts.jobId || null,
        iteration: i,
        model,
        tokens: used,
        remainingTokens,
        durationMs: Date.now() - started,
        ok: last.ok,
        placeholdersVisible: last.placeholdersVisible,
        ops: last.ops.length,
        // OpenRouter is forbidden for the document-engine vision loop.
      });
      if (last.ok && !last.placeholdersVisible) break;
    } catch (err) {
      remainingTokens -= maxTokens;
      log.push({
        jobId: opts.jobId || null,
        iteration: i,
        model,
        error: String(err?.message || err).slice(0, 400),
        remainingTokens,
      });
    }
  }

  const failed = log.some((e) => e.placeholdersVisible) && !last.ok;
  return {
    ok: !failed,
    skipped: false,
    iterations: log.filter((e) => !e.skipped).length,
    log,
    verdict: last,
    ops: last.ops || [],
  };
}

function parseVerdict(text) {
  try {
    const json = String(text || '').replace(/^```json\s*|```$/g, '').trim();
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    const parsed = JSON.parse(json.slice(start, end + 1));
    let ops = [];
    try {
      ops = Array.isArray(parsed.ops) ? parseClosedDsl(parsed.ops) : [];
    } catch {
      ops = [];
    }
    return {
      ok: parsed.ok !== false,
      placeholdersVisible: Boolean(parsed.placeholdersVisible),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      ops,
    };
  } catch {
    const lower = String(text || '').toLowerCase();
    const placeholdersVisible = /xxxxxxxx|placeholder|plantilla vac/.test(lower);
    return { ok: !placeholdersVisible, placeholdersVisible, issues: [], ops: [] };
  }
}

module.exports = {
  createDeepSeekClient,
  pickDeepSeekModel,
  runVerifyLoop,
  parseVerdict,
};
