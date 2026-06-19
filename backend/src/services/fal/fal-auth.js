'use strict';

const FAL_API_KEY_ENV_CANDIDATES = Object.freeze([
  'FAL_KEY',
  'FAL_API_KEY',
  'FAL_AI_API_KEY',
  'FALAI_API_KEY',
  // Kept as a backward-compatible alias for older SiraGPT env files.
  'TAL_AI_API_KEY',
]);

function cleanEnvValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const unquoted = raw.replace(/^['"]|['"]$/g, '').trim();
  return unquoted.replace(/^(Bearer|Key)\s+/i, '').trim();
}

function getFalApiKey(env = process.env) {
  const combinedKey = cleanEnvValue(env.FAL_KEY_ID) && cleanEnvValue(env.FAL_KEY_SECRET)
    ? `${cleanEnvValue(env.FAL_KEY_ID)}:${cleanEnvValue(env.FAL_KEY_SECRET)}`
    : '';
  if (combinedKey) return combinedKey;

  for (const name of FAL_API_KEY_ENV_CANDIDATES) {
    const value = cleanEnvValue(env[name]);
    if (value) return value;
  }

  return '';
}

function getFalApiKeySource(env = process.env) {
  if (cleanEnvValue(env.FAL_KEY_ID) && cleanEnvValue(env.FAL_KEY_SECRET)) {
    return 'FAL_KEY_ID/FAL_KEY_SECRET';
  }

  for (const name of FAL_API_KEY_ENV_CANDIDATES) {
    if (cleanEnvValue(env[name])) return name;
  }

  return null;
}

module.exports = {
  FAL_API_KEY_ENV_CANDIDATES,
  cleanEnvValue,
  getFalApiKey,
  getFalApiKeySource,
};
