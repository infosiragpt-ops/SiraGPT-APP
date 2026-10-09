'use strict';

// fal.queue.submit's SDK retries POST three times, even without a provider
// idempotency guarantee. Submit once; retry only safe status/result reads.
async function submitFalQueueOnce(endpoint, { input, signal, credentials, fetchImpl = fetch }) {
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9_./-]+$/i.test(endpoint) || endpoint.includes('..')) throw Object.assign(new Error('Modelo no válido.'), { code: 'E_PARAMS', status: 400 });
  const response = await fetchImpl(`https://queue.fal.run/${endpoint}`, {
    method: 'POST', headers: { Authorization: `Key ${credentials}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal,
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error('El proveedor no pudo aceptar la solicitud.'), { status: response.status, code: 'E_PROVIDER' });
  }
  return response.json();
}
module.exports = { submitFalQueueOnce };
