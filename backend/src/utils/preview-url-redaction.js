'use strict';

/**
 * URL/path redaction for tokenized preview routes. Preview tokens are bearer
 * credentials even when the request itself is rejected, so access/error/
 * telemetry loggers must never serialize their path segment.
 */
function redactPreviewUrl(rawUrl) {
  const raw = String(rawUrl || '');
  const tokenized = raw
    .replace(/(\/api\/code-runner\/[^/?#]+\/)[^/?#]+(\/app(?:\/|$))/gi, '$1[REDACTED]$2')
    .replace(/(\/api\/codex\/projects\/[^/?#]+\/preview\/)[^/?#]+(\/app(?:\/|$))/gi, '$1[REDACTED]$2');
  return tokenized.replace(/([?&](?:token|access_token|api[_-]?key|signature|sig|__sgpt_preview_nonce)=)[^&#]*/gi, '$1[REDACTED]');
}

module.exports = { redactPreviewUrl };
