'use strict';

const { ensureWorkspaceForChat, importAgentArtifact } = require('../cowork/workspace-store');
const { statusForAgentStopReason } = require('./react-run-outcome');
const { throwIfAborted } = require('../../utils/abort-signals');

const FAILURE_REASON = 'control_plane_error:workspace_delivery_failed';
const FAILURE_MESSAGE = 'El archivo descargable está disponible, pero no pude guardarlo en el espacio de trabajo. Reintenta el guardado.';
const CANCEL_MESSAGE = 'Se detuvo el guardado en el espacio de trabajo. Los archivos que ya se guardaron se conservan.';

/** Await only accepted final artifacts. Each import uses the canonical owner,
 * path, byte-limit and per-file transaction/version checks; the batch is not
 * atomic. A partial failure must never turn into a successful task completion.
 */
async function finalizeWorkspaceDelivery({
  prisma, userId, chatId, artifacts, finalMarkdown, stoppedReason, signal, emit,
} = {}) {
  const result = { finalMarkdown, stoppedReason, workspaceDelivery: null };
  if (!chatId || !Array.isArray(artifacts) || !artifacts.length
    || statusForAgentStopReason(stoppedReason) !== 'completed') return result;

  let workspaceId = null;
  let imported = 0;
  try {
    throwIfAborted(signal);
    const workspace = await ensureWorkspaceForChat(prisma, { userId, chatId });
    workspaceId = workspace.id;
    for (const artifact of artifacts) {
      throwIfAborted(signal);
      const file = await importAgentArtifact(prisma, {
        workspaceId,
        userId,
        artifactId: artifact.id,
        signal,
        // Metadata owned by the artifact is the canonical filename/MIME source.
        // Never trust a model-supplied path or create a second version on replay.
      });
      imported += 1;
      emit?.({
        type: 'cowork_file_changed', workspaceId,
        file: { id: file.id, path: file.path, version: file.currentVersion,
          mime: file.mime, size: file.size, artifactId: file.artifactId },
      });
    }
    throwIfAborted(signal);
    return { ...result, workspaceDelivery: { status: 'completed', workspaceId, imported } };
  } catch (_) {
    const cancelled = Boolean(signal?.aborted);
    // Storage/DB failures may contain URLs, credentials or private filenames.
    // Keep the existing download, but never echo those diagnostics or the
    // model's premature claim that it saved the file in the workspace.
    const message = cancelled ? CANCEL_MESSAGE : FAILURE_MESSAGE;
    emit?.({ type: 'quality_gate', gate: 'workspace_delivery', label: 'Guardado en el espacio de trabajo',
      passed: false, summary: message });
    return {
      finalMarkdown: message,
      stoppedReason: cancelled ? 'aborted' : FAILURE_REASON,
      workspaceDelivery: { status: cancelled ? 'cancelled' : 'failed', workspaceId, imported },
    };
  }
}

module.exports = { finalizeWorkspaceDelivery };
