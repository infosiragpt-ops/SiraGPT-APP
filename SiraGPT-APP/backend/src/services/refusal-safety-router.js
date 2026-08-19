'use strict';

const conceptExtractor = require('./concept-extractor');

const RISKY_PATTERNS = [
  { category: 'malware_creation', test: /\b(?:c[oó]mo|how to|teach me to|ens[eé]ñame)\b.{0,40}\b(?:hackear|crackear|hack|crack|exploit|compromise|breach|malware|ransomware)\b/i, verdict: 'refuse', rationale: 'Solicita herramientas/instrucciones para crear o desplegar malware.', safeAlternative: 'Propón hablar de defensa: detección, mitigación, hardening, threat-modeling, CTF educativo.' },
  { category: 'mass_targeting', test: /\b(?:env[ií]a|enviar|send|deliver)\s+(?:miles|cientos|hundreds|thousands)\s+(?:de\s+)?(?:emails|sms|mensajes|spam)\b/i, verdict: 'refuse', rationale: 'Solicita envío masivo no consentido (spam).', safeAlternative: 'Sugiere opt-in marketing legítimo con consentimiento.' },
  { category: 'destructive_command', test: /\b(?:rm\s+-rf\s+\/|drop\s+(?:database|table)\s+\w+|truncate\s+table\s+\w+|delete\s+from\s+\w+\s+(?:without|sin)\s+where|format\s+c:|mkfs\.|dd\s+if=\/dev\/zero)/i, verdict: 'caution', rationale: 'Comando destructivo en producción.', safeAlternative: 'Confirma entorno no-prod, backups recientes y dry-run.' },
  { category: 'financial_action', test: /\b(?:transfer|env[ií]a|wire|move)\s+\$?\d[\d,.]*\s+(?:usd|eur|mxn|millones?|millions?|dollars?)/i, verdict: 'route_to_human', rationale: 'Acción financiera con dinero real.', safeAlternative: 'El usuario debe ejecutarla desde su sistema bancario.' },
  { category: 'medical_dosage', test: /\b(?:dosis|dose|dosage)\s+(?:de\s+|of\s+)?[a-z][a-z0-9-]{2,40}\s+(?:para|for)\s+(?:un|a|mi|my|el|the)\b/i, verdict: 'route_to_human', rationale: 'Solicita dosificación médica.', safeAlternative: 'Recomienda consultar a un profesional sanitario.' },
  { category: 'legal_filing', test: /\b(?:demanda|lawsuit|sue|filing|petici[oó]n)\s+(?:contra|against)\s+/i, verdict: 'route_to_human', rationale: 'Solicita acción legal contra una parte.', safeAlternative: 'Sugiere un abogado certificado para validar.' },
  { category: 'personal_pii_dump', test: /\b(?:dame|d[áa]me|give me|share)\s+(?:su|her|his|their)\s+(?:tel[eé]fono|phone|direcci[oó]n|address|ssn|nss|n[uú]mero\s+de\s+seguridad)\b/i, verdict: 'refuse', rationale: 'Pide PII de otra persona sin contexto autorizado.', safeAlternative: 'Pide consentimiento documentado o usa canales legítimos.' },
  { category: 'self_harm', test: /\b(?:c[oó]mo|how to)\s+(?:suicid|matarme|kill\s+myself|end\s+my\s+life|hurt\s+myself)\b/i, verdict: 'route_to_human', rationale: 'Indicios de autolesión.', safeAlternative: 'Responde con empatía y recursos de ayuda inmediata.' },
];

function safeText(s) { return String(s == null ? '' : s).slice(0, 6000); }
const PRECEDENCE = { allow: 0, caution: 1, route_to_human: 2, refuse: 3 };

function classify({ prompt = '' } = {}) {
  const text = safeText(prompt);
  if (!text.trim()) return { verdict: 'allow', triggers: [], rationale: null, recommendation: null };
  const triggers = [];
  for (const pat of RISKY_PATTERNS) {
    const m = text.match(pat.test);
    if (m) triggers.push({ category: pat.category, verdict: pat.verdict, surface: m[0].slice(0, 120), rationale: pat.rationale, safeAlternative: pat.safeAlternative });
  }
  const { concepts } = conceptExtractor.extractConcepts(text);
  const refuseConcept = concepts.find((c) => c.kind === 'action.refuse_unsafe');
  if (refuseConcept && !triggers.length) {
    triggers.push({ category: 'concept_extractor_flag', verdict: 'caution', surface: refuseConcept.surface, rationale: 'Concept extractor flagged a refuse_unsafe action token.', safeAlternative: 'Pide al usuario aclaración del objetivo legítimo antes de actuar.' });
  }
  if (!triggers.length) return { verdict: 'allow', triggers: [], rationale: null, recommendation: null };
  triggers.sort((a, b) => PRECEDENCE[b.verdict] - PRECEDENCE[a.verdict]);
  const top = triggers[0];
  return { verdict: top.verdict, triggers, rationale: top.rationale, recommendation: top.safeAlternative };
}

function buildSafetyBlock(result) {
  if (!result || result.verdict === 'allow') return '';
  const lines = ['## SAFETY ROUTER ALERT', `Verdict: **${result.verdict.toUpperCase()}** — ${result.rationale}`, `Recommended alternative: ${result.recommendation}`];
  if (result.triggers.length > 1) {
    lines.push('Other triggers:');
    for (const t of result.triggers.slice(1, 4)) lines.push(`- [${t.category}/${t.verdict}] ${t.surface}`);
  }
  return lines.join('\n');
}

module.exports = { classify, buildSafetyBlock, RISKY_PATTERNS };
