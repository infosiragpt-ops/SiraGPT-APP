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

const ADMIN_KEY_PREFIX = 'enc:v1:';

function decryptAdminConnectionKey(stored, decryptFn) {
  const raw = cleanEnvValue(stored);
  if (!raw) return '';
  if (!raw.startsWith(ADMIN_KEY_PREFIX)) return raw;
  try {
    const decrypt = decryptFn || require('../../utils/encryption').decrypt;
    return cleanEnvValue(decrypt(raw.slice(ADMIN_KEY_PREFIX.length)));
  } catch (error) {
    console.error('[fal-auth] failed to decrypt admin fal.ai key:', error.message);
    return '';
  }
}

async function getAdminFalApiKey({ prisma, decryptFn } = {}) {
  const db = prisma || require('../../config/database');
  if (!db?.adminConnection?.findFirst) return '';

  const row = await db.adminConnection.findFirst({
    where: {
      providerKey: 'fal',
      enabled: true,
      apiKey: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    select: { apiKey: true },
  });

  return decryptAdminConnectionKey(row?.apiKey, decryptFn);
}

async function resolveFalApiKey({ env = process.env, prisma, decryptFn } = {}) {
  const adminKey = await getAdminFalApiKey({ prisma, decryptFn }).catch((error) => {
    console.error('[fal-auth] failed to read admin fal.ai key:', error.message);
    return '';
  });
  if (adminKey) return { apiKey: adminKey, source: 'admin_connections:fal' };

  const envKey = getFalApiKey(env);
  return { apiKey: envKey, source: getFalApiKeySource(env) };
}

module.exports = {
  FAL_API_KEY_ENV_CANDIDATES,
  cleanEnvValue,
  decryptAdminConnectionKey,
  getAdminFalApiKey,
  getFalApiKey,
  getFalApiKeySource,
  resolveFalApiKey,
};
