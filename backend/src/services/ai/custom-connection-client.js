'use strict';

const OpenAI = require('openai');

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

function resolveCustomConnectionConfig(env = process.env) {
  const baseURL = String(env.CUSTOM_BASE_URL || env.OLLAMA_HOST || env.OLLAMA_BASE_URL || '').trim()
    || DEFAULT_LOCAL_BASE_URL;
  const apiKey = String(env.CUSTOM_API_KEY || env.OLLAMA_API_KEY || 'ollama').trim() || 'ollama';
  return { baseURL, apiKey };
}

function createCustomConnectionClient(env = process.env, OpenAIClient = OpenAI) {
  const { baseURL, apiKey } = resolveCustomConnectionConfig(env);
  return new OpenAIClient({ apiKey, baseURL });
}

module.exports = {
  DEFAULT_LOCAL_BASE_URL,
  createCustomConnectionClient,
  resolveCustomConnectionConfig,
};
