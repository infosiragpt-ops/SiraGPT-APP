const OpenAI = require('openai');

// Provider client factory for the document content generator. Mirrors the
// provider switch used in routes/ai.js so a future caller can flow the
// user's selected model (DeepSeek V4 Flash, Gemini, OpenRouter, …) into
// the pipeline without rewriting this file. Defaults to OpenAI because
// gpt-4o-mini is the most cost/latency-optimal choice for the small
// JSON outputs this module produces and OPENAI_API_KEY is the most
// widely provisioned key in this codebase.
//
// The returned client is OpenAI-SDK-compatible (chat.completions.create
// with response_format), so all callers use one shape regardless of the
// underlying provider.
function createContentClient(provider = 'OpenAI') {
  switch ((provider || 'OpenAI').trim()) {
    case 'Gemini':
      return new OpenAI({
        apiKey: process.env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      });
    case 'DeepSeek':
      return new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
    case 'OpenRouter':
      return new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    case 'OpenAI':
    default:
      return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
}

// Most cost/latency-friendly model that reliably honours response_format
// json_schema and produces tight Spanish/English bullets. Override per
// deployment with DOC_CONTENT_MODEL without touching code.
const DEFAULT_MODEL = process.env.DOC_CONTENT_MODEL || 'gpt-4o-mini';

module.exports = { createContentClient, DEFAULT_MODEL };
