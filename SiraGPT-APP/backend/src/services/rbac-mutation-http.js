'use strict';

function isRbacMutationBusyError(error) {
  return error?.code === 'RBAC_MUTATION_BUSY'
    && Number(error?.statusCode || error?.status) === 503;
}

function sendRbacMutationBusyResponse(res, error) {
  if (!isRbacMutationBusyError(error)) return false;
  const retryAfterSeconds = Number(error.retryAfterSeconds);
  res.setHeader(
    'Retry-After',
    String(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds)
      : 1),
  );
  res.status(503).json({
    error: 'RBAC mutation service is busy',
    code: 'RBAC_MUTATION_BUSY',
    retryable: true,
  });
  return true;
}

module.exports = {
  isRbacMutationBusyError,
  sendRbacMutationBusyResponse,
};
