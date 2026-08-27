'use strict';

const { redactSecrets } = require('./redact');

function safeMetadata(metadata) {
  return redactSecrets(metadata && typeof metadata === 'object' ? metadata : {});
}

async function auditAppEvent(prisma, {
  userId,
  action,
  appId,
  connectionId = null,
  req = null,
  metadata = {},
} = {}) {
  const payload = {
    actorType: 'user',
    userId: userId || null,
    action: String(action || 'app_event'),
    resource: 'app_connection',
    resourceId: connectionId || appId || null,
    metadata: safeMetadata({ appId, ...metadata }),
    tags: ['apps', 'oauth', appId].filter(Boolean),
    req,
  };
  try {
    // eslint-disable-next-line global-require
    const { writeAuditLog } = require('../../utils/audit-log');
    return await writeAuditLog(prisma, payload);
  } catch {
    return null;
  }
}

module.exports = {
  auditAppEvent,
  safeMetadata,
};
