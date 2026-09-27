'use strict';

/**
 * Human verdict for Admin → Conexiones «Probar». The upstream provider
 * rejecting a key (401), running out of credits (402) or timing out is the
 * answer to the admin's question, not a server fault: the route replies 200
 * `{ ok:false, reason }` with this Spanish sentence, and the panel shows it
 * instead of «Server error». Only genuine faults of our own code are 5xx.
 */

const PROVIDER_NAMES = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  gemini: 'Gemini',
  google: 'Gemini',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  cerebras: 'Cerebras',
  together: 'Together',
  fireworks: 'Fireworks',
  perplexity: 'Perplexity',
  elevenlabs: 'ElevenLabs',
  minimax: 'MiniMax',
  suno: 'Suno',
  fal: 'fal.ai',
  brave: 'Brave',
  tavily: 'Tavily',
  exa: 'Exa',
  typesafe: 'TypeSafe',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  vllm: 'vLLM',
};

const KEY_REJECTED_RE = /api[\s_-]?key|invalid[\s_-]?(?:x-)?(?:api[\s_-]?)?key|incorrect api key|unauthori[sz]ed|authentication|invalid[\s_-]?token|permission[\s_-]?denied|forbidden/i;
const NO_CREDITS_RE = /insufficient[\s_-]?(?:balance|credits?|quota|funds)|credit balance|out of credits|billing|payment required|quota exceeded|exceeded your current quota/i;
const TIMEOUT_RE = /timeout|timed out|aborted|ETIMEDOUT/i;
const DNS_RE = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i;
const REFUSED_RE = /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|network/i;

// Keys sometimes come back echoed (masked or not) in provider error bodies.
const SECRET_RE = /\b(?:sk|pk|rk|xai|gsk|ghp|github_pat|sk-ant|sk-proj)[-_][A-Za-z0-9_*.-]{6,}|\bAIza[0-9A-Za-z_-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

function providerDisplayName({ providerKey, providerLabel } = {}) {
  const key = String(providerKey || '').toLowerCase();
  if (PROVIDER_NAMES[key]) return PROVIDER_NAMES[key];
  const label = String(providerLabel || '').trim();
  if (label && label.toLowerCase() !== 'custom') return label;
  return 'el proveedor';
}

function redactProbeDetail(detail) {
  return String(detail || '').replace(SECRET_RE, '[clave]').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * @param {{ providerKey?:string, providerLabel?:string, status?:number, error?:string }} probe
 * @returns {string} one Spanish sentence for the admin.
 */
function describeConnectionProbeFailure(probe = {}) {
  const name = providerDisplayName(probe);
  const apiOf = name === 'el proveedor' ? 'La API del proveedor' : `La API de ${name}`;
  const status = Number(probe.status) || 0;
  const error = String(probe.error || '');

  if (/^missing_api_key$/i.test(error)) return `Falta la API key de ${name}.`;
  if (/^missing_url$/i.test(error)) return 'Falta la URL base de la conexión.';
  if (/^fetch_unavailable$/i.test(error)) return 'El servidor no puede hacer peticiones salientes ahora mismo.';
  if (/^bad_json/i.test(error)) return `${name === 'el proveedor' ? 'El proveedor' : name} respondió algo que no es JSON: revisa la URL base.`;

  if (status === 401 || status === 403) return `${apiOf} rechazó la clave (${status}).`;
  if (status === 402 || (status === 429 && NO_CREDITS_RE.test(error))) {
    return `La cuenta de ${name} no tiene saldo o créditos (${status}).`;
  }
  if (status === 429) return `${apiOf} está limitando las peticiones (429). Prueba de nuevo en un momento.`;
  if (status === 404) return `${apiOf} no encontró la ruta /models (404): revisa la URL base.`;
  if (status === 408 || (status === 0 && TIMEOUT_RE.test(error))) return `${apiOf} no respondió a tiempo.`;
  if (status >= 500) return `${apiOf} respondió con un error de su servidor (${status}). Prueba más tarde.`;
  if (status >= 400) {
    if (KEY_REJECTED_RE.test(error)) return `${apiOf} rechazó la clave (${status}).`;
    if (NO_CREDITS_RE.test(error)) return `La cuenta de ${name} no tiene saldo o créditos (${status}).`;
    return `${apiOf} rechazó la prueba (${status}).`;
  }
  if (DNS_RE.test(error)) return `No se pudo resolver el dominio de ${name}: revisa la URL base.`;
  if (REFUSED_RE.test(error)) return `No se pudo conectar con ${name}.`;
  const detail = redactProbeDetail(error);
  return detail ? `La prueba falló: ${detail}` : 'La prueba falló sin detalle del proveedor.';
}

module.exports = {
  describeConnectionProbeFailure,
  providerDisplayName,
  redactProbeDetail,
};
