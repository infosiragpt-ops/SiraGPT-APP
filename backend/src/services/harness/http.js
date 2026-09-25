'use strict';

const { errorFromResponse, toProviderError, isAbortError } = require('./errors');

/**
 * POST a JSON body and return the streaming Response. Non-2xx statuses are
 * turned into HarnessProviderError (status, retry-after, trimmed body) so
 * the loop's retry policy can act on them. `fetchImpl` is injectable for
 * tests; default is the runtime's global fetch (undici).
 */
async function postJsonStream(url, { headers = {}, body, signal, fetchImpl, provider }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || (signal && signal.aborted)) throw err;
    throw toProviderError(err, provider);
  }
  if (!res.ok) throw await errorFromResponse(res, provider);
  return res;
}

function safeJsonParse(text) {
  if (text == null || text === '') return { value: {}, error: null };
  try {
    const value = JSON.parse(text);
    return { value, error: null };
  } catch (err) {
    return { value: null, error: err.message };
  }
}

module.exports = { postJsonStream, safeJsonParse };
