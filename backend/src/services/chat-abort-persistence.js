'use strict';

const STOPPED_BY_USER_MARKER = '(Generation stopped by user)';

function resolveAbortedAssistantContent(fullResponseContent) {
  const abortedContent = String(fullResponseContent || '').trim();
  return abortedContent || STOPPED_BY_USER_MARKER;
}

module.exports = {
  STOPPED_BY_USER_MARKER,
  resolveAbortedAssistantContent,
};
