'use strict';

const { randomUUID } = require('node:crypto');
const { normalize } = require('../agents/software-build-intent');

// Recognize an instruction to connect, never explanatory prose, code or a
// disconnect request. Opening consent does not authorize any repository write.
function isGithubConnectRequest(input) {
  const text = normalize(String(input || '').replace(/```[\s\S]*?```/g, ' '));
  if (!/\bgithub\b/.test(text) || text.length > 1500) return false;
  if (/\b(?:do not|don['’]t|never)\s+(?:connect|open|authoriz|log ?in|sign ?in)|\b(?:no|nunca|sin)\s+(?:(?:quiero|deseo)\s+(?:que\s+)?|me\s+|debes?\s+)*(?:conect|abr|inici|autoriz)|\b(?:desconect\w*|disconnect\w*|revoca\w*)\b/.test(text)) return false;
  if (/\b(?:como (?:puedo |se |hago para )?(?:conect|inici|acced|autoriz)\w*|explica\w*|(?:para )?que (?:es|significa|sirve)|how (?:do|can|to))\b/.test(text)) return false;
  const accountAccess = /\b(?:cuenta|sesion|loguear\w*|log ?in|sign ?in|oauth|autoriz\w*|acceder|acceso)\b/.test(text);
  if (!accountAccess && /github\.com\/|\b(?:repositorio|repo|pull request|pr|codigo)\b/.test(text)) return false;
  return /\b(?:conecta(?:r|me)?|connect|inicia(?:r)? sesion|iniciar sesion|loguea(?:r|me)?|loguearme|log ?in|sign ?in|accede(?:r)?|autoriza(?:r)?)\b/.test(text)
    || /\b(?:abre|abrir|abrirme|open|dame|pasame|pasa|envia)\b.{0,100}\b(?:github|link|enlace|acceso)\b/.test(text);
}

const GITHUB_TOOLS = new Set([
  'github_open_repo', 'github_repo_list', 'github_repo_read', 'github_repo_write',
  'github_repo_exec', 'github_open_pull_request', 'github_publish_project', 'github_list_repos',
  'project_clone_repo', 'project_open_pull_request', 'project_pull_request_checks',
]);
const AUTH_CODES = new Set(['github_auth_required', 'github_not_connected', 'github_token_invalid', 'not_connected', 'E_GITHUB_CONNECT']);
function needsGithubConnection(tool, observation) {
  if (!GITHUB_TOOLS.has(tool) || !observation || typeof observation !== 'object' || observation.ok === true) return false;
  return [observation.code, observation.error, observation.status].some(value => typeof value === 'string' && AUTH_CODES.has(value));
}

function createGithubChatHandoff({ userId, chatId, signal, emit }) {
  let handoff = null;
  const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
  return {
    get pending() { return handoff; },
    async request() {
      if (signal?.aborted || !validId(userId) || !validId(chatId) || chatId.length > 64) return null;
      if (!handoff) {
        handoff = { type: 'github_connection_required', chatId, handoffId: randomUUID() };
        await emit(handoff);
      }
      return handoff;
    },
    async observe(tool, observation) {
      return needsGithubConnection(tool, observation) ? this.request() : null;
    },
  };
}

const GITHUB_HANDOFF_MESSAGE = 'La conexión con GitHub está pendiente de tu autorización. Continúa en la pestaña de GitHub; si el navegador bloquea la apertura, usa «Abrir GitHub». Cuando se confirme la conexión, retomaré la tarea pendiente de este chat con los permisos que ya autorizaste.';
module.exports = { isGithubConnectRequest, needsGithubConnection, createGithubChatHandoff, GITHUB_HANDOFF_MESSAGE };
