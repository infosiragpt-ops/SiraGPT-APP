'use strict';

const { requireOwnedChat } = require('../codex/project-chat-binding');
const { isGithubConnectRequest, createGithubChatHandoff, GITHUB_HANDOFF_MESSAGE } = require('./github-chat-handoff');
const { throwIfAborted } = require('../../utils/abort-signal');

/** Account connection is a UI action, not a model tool call. Run before the
 * model-capability/agentic routing gates, but keep the ordinary chat's owner,
 * current-attachment, modality, Stop and explicit tool-disable boundaries.
 * The HTTP route still owns persistence, quota preflight and SSE completion.
 */
async function handleGithubConnectionTurn({ prompt, userId, chatId, db, files = [], modality, publicWebReadonly = false, disableAgentic = false, signal, emit }) {
  if (!userId || !chatId || publicWebReadonly || disableAgentic || modality
    || (Array.isArray(files) && files.length > 0) || !isGithubConnectRequest(prompt)) return null;
  throwIfAborted(signal);
  await requireOwnedChat({ userId, chatId, db });
  throwIfAborted(signal);
  const handoff = createGithubChatHandoff({ userId, chatId, signal, emit });
  if (!await handoff.request()) return null;
  await emit({ replace: true, content: GITHUB_HANDOFF_MESSAGE });
  return { answer: GITHUB_HANDOFF_MESSAGE, handoff: handoff.pending };
}

module.exports = { handleGithubConnectionTurn };
