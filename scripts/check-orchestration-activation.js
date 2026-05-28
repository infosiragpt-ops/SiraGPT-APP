#!/usr/bin/env node
'use strict';

// check-orchestration-activation — CLI report that loads backend/.env
// and asks the orchestration-wireup which subsystems would activate
// with the current configuration. Same source-of-truth as the runtime
// /api/orchestration/health endpoint, but doesn't require a booted
// server. Always exits 0 — purely informational.
//
// Usage: node scripts/check-orchestration-activation.js [--json]

const path = require('node:path');
const fs = require('node:fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function colorize(text, color) {
  const colors = { red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, gray: 90, bold: 1 };
  if (!process.stdout.isTTY) return text;
  const code = colors[color];
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function describeSubsystem(name, status, requiredEnv = [], notes = '') {
  return { name, status, requiredEnv, notes };
}

function classifySearchProviders(env) {
  const providers = [];
  if (env.TAVILY_API_KEY) providers.push('tavily');
  if (env.EXA_API_KEY) providers.push('exa');
  if (env.FIRECRAWL_API_KEY) providers.push('firecrawl');
  if (env.SEARXNG_URL) providers.push('searxng');
  return providers;
}

function classifyLLMProviders(env) {
  const providers = [];
  if (env.ANTHROPIC_API_KEY) providers.push('anthropic');
  if (env.OPENAI_API_KEY) providers.push('openai');
  if (env.OPENROUTER_API_KEY) providers.push('openrouter');
  if (env.GROQ_API_KEY) providers.push('groq');
  if (env.DEEPSEEK_API_KEY) providers.push('deepseek');
  if (env.GOOGLE_AI_API_KEY || env.GEMINI_API_KEY) providers.push('google');
  if (env.MISTRAL_API_KEY) providers.push('mistral');
  return providers;
}

async function inspect() {
  const repoRoot = path.resolve(__dirname, '..');
  loadEnvFile(path.join(repoRoot, 'backend/.env'));
  loadEnvFile(path.join(repoRoot, '.env'));
  loadEnvFile(path.join(repoRoot, '.env.local'));

  const env = process.env;
  const subsystems = [];

  const llmProviders = classifyLLMProviders(env);
  subsystems.push(describeSubsystem(
    'LLM Gateway',
    llmProviders.length > 0 ? 'active' : 'disabled',
    ['ANTHROPIC_API_KEY (or other provider)'],
    `Configured providers: ${llmProviders.length ? llmProviders.join(', ') : 'none'}`,
  ));

  subsystems.push(describeSubsystem(
    'Voyage Embeddings',
    env.VOYAGE_API_KEY ? 'active' : (env.JINA_API_KEY ? 'fallback-active (jina)' : 'disabled'),
    ['VOYAGE_API_KEY', 'JINA_API_KEY (fallback)'],
    env.SIRAGPT_MEMORY_EMBED_MODEL ? `Model: ${env.SIRAGPT_MEMORY_EMBED_MODEL}` : '',
  ));

  subsystems.push(describeSubsystem(
    'Upstash Semantic Cache',
    (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) ? 'active' : 'disabled',
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    'LLM response cache; ~30-60% latency reduction on repeated queries.',
  ));

  const searchProviders = classifySearchProviders(env);
  subsystems.push(describeSubsystem(
    'Web Search',
    searchProviders.length > 0 ? 'active' : 'disabled',
    ['TAVILY_API_KEY', 'EXA_API_KEY', 'FIRECRAWL_API_KEY', 'SEARXNG_URL'],
    `Configured: ${searchProviders.length ? searchProviders.join(', ') : 'none'}`,
  ));

  subsystems.push(describeSubsystem(
    'Cloudflare R2 Storage',
    (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME && env.R2_ENDPOINT) ? 'active' : 'disabled',
    ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT'],
    'Heavy artifact storage; presigned URLs.',
  ));

  subsystems.push(describeSubsystem(
    'Langfuse Tracing',
    (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) ? 'active' : 'disabled',
    ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST (optional)'],
    'Per-generation cost / latency / token traces.',
  ));

  subsystems.push(describeSubsystem(
    'Sentry Errors',
    env.SENTRY_DSN ? 'active' : 'disabled',
    ['SENTRY_DSN'],
    `Sample rate: ${env.SENTRY_TRACES_SAMPLE_RATE || '0 (off)'}.`,
  ));

  subsystems.push(describeSubsystem(
    'Multichannel (OpenClaw)',
    String(env.OPENCLAW_ENABLED || '').toLowerCase() === 'true' && env.OPENCLAW_API_KEY ? 'active' : 'disabled',
    ['OPENCLAW_ENABLED=true', 'OPENCLAW_API_KEY', 'OPENCLAW_GATEWAY_URL'],
    `Channels: ${env.OPENCLAW_CHANNELS || 'default'}`,
  ));

  subsystems.push(describeSubsystem(
    'Postgres pgvector User Memory',
    (env.SIRAGPT_USER_MEMORY_STORE || '').toLowerCase() === 'pgvector' ? 'active' : 'disabled',
    ['SIRAGPT_USER_MEMORY_STORE=pgvector', 'Requires migration 20260520180000_add_user_memories_pgvector'],
    `Embed provider: ${env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage (default)'}`,
  ));

  return subsystems;
}

function printHuman(subsystems) {
  const active = subsystems.filter((s) => s.status.startsWith('active') || s.status.startsWith('fallback'));
  const disabled = subsystems.filter((s) => s.status === 'disabled');

  console.log(colorize('\nSiraGPT Orchestration · Activation Check\n', 'bold'));

  if (active.length > 0) {
    console.log(colorize(`✅ Active subsystems (${active.length}):`, 'green'));
    for (const s of active) {
      console.log(`  - ${colorize(s.name, 'bold')} ${colorize(`(${s.status})`, 'green')}`);
      if (s.notes) console.log(`      ${colorize(s.notes, 'gray')}`);
    }
    console.log('');
  }

  if (disabled.length > 0) {
    console.log(colorize(`⚠️  Disabled subsystems (${disabled.length}):`, 'yellow'));
    for (const s of disabled) {
      console.log(`  - ${colorize(s.name, 'bold')}`);
      console.log(`      needs: ${s.requiredEnv.join(', ')}`);
      if (s.notes) console.log(`      ${colorize(s.notes, 'gray')}`);
    }
    console.log('');
  }

  console.log(colorize(`Summary: ${active.length} active / ${disabled.length} disabled`, 'cyan'));
  console.log(colorize('Tip: edit backend/.env and re-run; runtime equivalent is GET /api/orchestration/health.\n', 'gray'));
}

(async () => {
  const args = process.argv.slice(2);
  try {
    const subsystems = await inspect();
    if (args.includes('--json')) {
      console.log(JSON.stringify({ subsystems }, null, 2));
    } else {
      printHuman(subsystems);
    }
    process.exit(0);
  } catch (err) {
    console.error('check-orchestration-activation failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
