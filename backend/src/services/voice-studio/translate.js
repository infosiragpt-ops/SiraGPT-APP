'use strict';

/**
 * Segment translation for dubbing.
 *
 * Default (zero cost, zero external API): VoiceStudio's offline NLLB-200
 * translator (`/dub/translate`, provider "nllb") — runs on the same host as
 * the voices. Optional: SiraGPT's LLM ladder (DeepSeek native → Meta → …,
 * see doc-agent/llm-runtime.js) when an operator lists `llm` in
 * VOICESTUDIO_TRANSLATE_PROVIDERS (e.g. "nllb,llm" = LLM only as fallback,
 * "llm,nllb" = LLM first). Sira Voz ships with "nllb".
 *
 * Contract: returns an array aligned with `segments` — same length, same
 * order — where every item is { id, text }. A segment the translator could
 * not produce keeps its original text (never blanks a line of the dub).
 */

const voiceStudio = require('../ai/voicestudio-client');

const DEFAULT_BATCH = 40;
const DEFAULT_PROVIDERS = ['nllb'];

function translateProviders(opts = {}) {
  const raw = opts.providers || (opts.env || process.env).VOICESTUDIO_TRANSLATE_PROVIDERS;
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',') : DEFAULT_PROVIDERS);
  const cleaned = list.map((v) => String(v || '').trim().toLowerCase()).filter((v) => v === 'nllb' || v === 'llm');
  return cleaned.length ? Array.from(new Set(cleaned)) : DEFAULT_PROVIDERS;
}

function languageLabel(value) {
  const name = voiceStudio.languageName(value);
  return name && name !== 'Auto' ? name : String(value || '');
}

function buildPrompt({ segments, targetLanguage, sourceLanguage, tone }) {
  const lines = segments.map((s, i) => `${i + 1}. ${String(s.text || '').replace(/\s+/g, ' ').trim()}`).join('\n');
  const src = sourceLanguage ? ` from ${languageLabel(sourceLanguage)}` : '';
  return [
    `You are a professional dubbing translator. Translate the numbered subtitle lines${src} into ${languageLabel(targetLanguage)}.`,
    'Rules:',
    '- Keep the meaning, register and emotion; natural spoken language, not literal.',
    '- Keep each line roughly the same length as the original so it fits the same time slot (concise).',
    '- Keep numbers, names and brand names.',
    `- ${tone || 'Neutral, natural tone.'}`,
    '- Answer ONLY with a JSON object of the form {"lines": [{"n": 1, "text": "..."}, ...]} covering every line number exactly once.',
    '',
    'Lines:',
    lines,
  ].join('\n');
}

function parseLines(raw, count) {
  const text = String(raw || '').trim();
  const out = new Map();
  const tryJson = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.lines) ? parsed.lines : null;
      if (!arr) return false;
      for (const item of arr) {
        const n = Number(item?.n ?? item?.index ?? item?.id);
        const value = typeof item?.text === 'string' ? item.text.trim() : '';
        if (Number.isInteger(n) && n >= 1 && n <= count && value) out.set(n, value);
      }
      return out.size > 0;
    } catch {
      return false;
    }
  };
  if (!tryJson(text)) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fence || !tryJson(fence[1])) {
      const brace = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (brace >= 0 && end > brace) tryJson(text.slice(brace, end + 1));
    }
  }
  if (!out.size) {
    // Last resort: "1. texto" lines.
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (m) out.set(Number(m[1]), m[2].trim());
    }
  }
  return out;
}

function defaultLlmClientFactory() {
  const { resolveDocAgentCandidates, createFailoverClient } = require('../doc-agent/llm-runtime');
  const candidates = resolveDocAgentCandidates({});
  if (!candidates.length) return null;
  return createFailoverClient(candidates);
}

/**
 * Translate segments with the LLM ladder. Throws when no provider is
 * configured or every batch failed; partial batches keep original text.
 */
async function translateWithLlm(segments, { targetLanguage, sourceLanguage = null, tone = '', batchSize = DEFAULT_BATCH, signal, clientFactory = defaultLlmClientFactory } = {}) {
  const client = clientFactory();
  if (!client) throw Object.assign(new Error('No LLM provider configured for translation'), { code: 'NO_LLM' });
  const results = segments.map((s) => ({ id: s.id, text: String(s.text || '') }));
  let translated = 0;
  for (let offset = 0; offset < segments.length; offset += batchSize) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const batch = segments.slice(offset, offset + batchSize);
    const nonEmpty = batch.filter((s) => String(s.text || '').trim());
    if (!nonEmpty.length) continue;
    const response = await client.chat.completions.create({
      messages: [
        { role: 'system', content: 'You translate dubbing scripts. Output strictly valid JSON.' },
        { role: 'user', content: buildPrompt({ segments: nonEmpty, targetLanguage, sourceLanguage, tone }) },
      ],
      temperature: 0.2,
      max_tokens: Math.min(8000, 200 + nonEmpty.reduce((acc, s) => acc + String(s.text || '').length * 2, 0)),
    }, signal ? { signal } : undefined);
    const raw = response?.choices?.[0]?.message?.content || '';
    const lines = parseLines(raw, nonEmpty.length);
    nonEmpty.forEach((seg, i) => {
      const value = lines.get(i + 1);
      if (value) {
        const idx = segments.indexOf(seg);
        results[idx] = { id: seg.id, text: value };
        translated += 1;
      }
    });
  }
  if (!translated && segments.some((s) => String(s.text || '').trim())) {
    throw Object.assign(new Error('The translator returned no usable lines'), { code: 'TRANSLATE_EMPTY' });
  }
  return results;
}

async function translateWithVoiceStudio(segments, { targetLanguage, sourceLanguage = null, signal } = {}, options = {}) {
  const body = await voiceStudio.dubTranslate({ segments, targetLang: targetLanguage, sourceLang: sourceLanguage, provider: 'nllb', signal }, options);
  // VoiceStudio answers `{ translated: [{ id, text }], target_lang, … }`
  // (older builds returned a bare array); accept every shape seen so far.
  const rows = Array.isArray(body) ? body
    : Array.isArray(body?.translated) ? body.translated
      : Array.isArray(body?.segments) ? body.segments
        : Array.isArray(body?.results) ? body.results : [];
  if (!rows.length) {
    throw Object.assign(new Error('El traductor local no devolvió líneas'), { code: 'TRANSLATE_EMPTY' });
  }
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return segments.map((s) => {
    const row = byId.get(String(s.id));
    const text = row && typeof row.text === 'string' && row.text.trim() && !row.error ? row.text.trim() : String(s.text || '');
    return { id: s.id, text };
  });
}

/**
 * Translate with the configured providers in order (default: local NLLB only);
 * the caller receives which engine produced the lines so the chat summary can
 * say so. A provider that throws hands over to the next one; when every
 * provider failed the error names them all.
 */
async function translateSegments(segments, opts = {}, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return { segments: [], engine: 'none' };
  const source = voiceStudio.languageCode(opts.sourceLanguage);
  const target = voiceStudio.languageCode(opts.targetLanguage);
  if (source && target && source === target) {
    return { segments: list.map((s) => ({ id: s.id, text: String(s.text || '') })), engine: 'same-language' };
  }
  const failures = [];
  for (const provider of translateProviders(opts)) {
    try {
      if (provider === 'llm') {
        const translated = await translateWithLlm(list, opts);
        return { segments: translated, engine: 'sira-llm', warning: failures.length ? failures.join('; ').slice(0, 200) : null };
      }
      const translated = await translateWithVoiceStudio(list, opts, options);
      return { segments: translated, engine: 'nllb', warning: failures.length ? failures.join('; ').slice(0, 200) : null };
    } catch (err) {
      if (err?.name === 'AbortError' || opts.signal?.aborted) throw err;
      failures.push(`${provider}: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  const wrapped = new Error(`No se pudo traducir el guion (${failures.join('; ')})`.slice(0, 400));
  wrapped.code = 'TRANSLATE_FAILED';
  throw wrapped;
}

module.exports = {
  DEFAULT_PROVIDERS,
  translateProviders,
  buildPrompt,
  parseLines,
  translateWithLlm,
  translateWithVoiceStudio,
  translateSegments,
};
