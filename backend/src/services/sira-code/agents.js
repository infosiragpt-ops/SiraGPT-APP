'use strict';

/**
 * SiraCode agent roster.
 *
 * Independent rewrite inspired by OpenCode's build / plan / general split
 * (anomalyco/opencode, MIT). Not affiliated with OpenCode or Anomaly.
 *
 * Stable ids stay English-neutral for the API; Spanish labels are what
 * `/agentes` renders. Never put provider or model_id strings here.
 */

const AGENT_IDS = Object.freeze(['construir', 'planificar', 'general']);

const AGENTS = Object.freeze({
  construir: Object.freeze({
    id: 'construir',
    label: 'Construir',
    role: 'build',
    description: 'Agente de código con lectura, edición y terminal en el sandbox.',
    tools: Object.freeze({
      read: 'allow',
      write: 'allow',
      edit: 'allow',
      bash: 'allow',
      grep: 'allow',
      glob: 'allow',
      ls: 'allow',
      apply_patch: 'allow',
      webfetch: 'allow',
      todo: 'allow',
    }),
    systemPrompt: [
      'Eres SiraCode en modo Construir.',
      'Trabajas solo dentro del workspace aislado de la sesión.',
      'Puedes leer, editar, buscar y ejecutar comandos allowlisted en el sandbox (sin red salvo permiso explícito).',
      'Si hay un plan aprobado en la sesión, ejecútalo; no lo reescribas.',
      'Nunca ejecutes fuera del sandbox. No menciones proveedores ni ids de modelo.',
      'Responde en el idioma del usuario. Sé concreto y aplica los cambios.',
    ].join(' '),
  }),
  planificar: Object.freeze({
    id: 'planificar',
    label: 'Planificar',
    role: 'plan',
    description: 'Agente de planificación: solo lectura y búsqueda. Escribir está denegado. El shell pide permiso y sigue sin poder escribir.',
    tools: Object.freeze({
      read: 'allow',
      write: 'deny',
      edit: 'deny',
      bash: 'ask',
      grep: 'allow',
      glob: 'allow',
      ls: 'allow',
      apply_patch: 'deny',
      webfetch: 'allow',
      todo: 'allow',
    }),
    systemPrompt: [
      'Eres SiraCode en modo Planificar.',
      'Solo puedes leer y buscar. No escribas ni edites archivos.',
      'Si necesitas un comando de terminal de solo lectura, pide permiso; no lo ejecutes solo. El shell nunca escribe en Planificar.',
      'Entrega un plan accionable de como máximo 7 pasos. No menciones proveedores ni ids de modelo.',
      'Responde en el idioma del usuario.',
    ].join(' '),
  }),
  general: Object.freeze({
    id: 'general',
    label: 'General',
    role: 'subagent',
    internal: true,
    description: 'Subagente interno de búsqueda multi-paso (solo lectura).',
    tools: Object.freeze({
      read: 'allow',
      write: 'deny',
      edit: 'deny',
      bash: 'deny',
      grep: 'allow',
      glob: 'allow',
      ls: 'allow',
      apply_patch: 'deny',
      webfetch: 'allow',
      todo: 'allow',
    }),
    systemPrompt: [
      'Eres un subagente de búsqueda de SiraCode.',
      'Explora el workspace con lectura y búsqueda. No escribas ni ejecutes shell.',
      'Devuelve hallazgos concretos al agente principal.',
    ].join(' '),
  }),
});

const DEFAULT_AGENT_ID = 'construir';

function isAgentId(value) {
  return AGENT_IDS.includes(String(value || '').trim());
}

function resolveAgentId(value, { allowInternal = true } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    build: 'construir',
    plan: 'planificar',
    construir: 'construir',
    planificar: 'planificar',
    general: 'general',
  };
  const id = aliases[raw] || DEFAULT_AGENT_ID;
  if (id === 'general' && !allowInternal) return DEFAULT_AGENT_ID;
  return id;
}

function getAgent(id, opts) {
  return AGENTS[resolveAgentId(id, opts)];
}

function listPublicAgents() {
  return AGENT_IDS
    .map((id) => AGENTS[id])
    .filter((agent) => agent && !agent.internal)
    .map((agent) => ({
      id: agent.id,
      label: agent.label,
      role: agent.role,
      description: agent.description,
    }));
}

module.exports = {
  AGENT_IDS,
  AGENTS,
  DEFAULT_AGENT_ID,
  isAgentId,
  resolveAgentId,
  getAgent,
  listPublicAgents,
};
