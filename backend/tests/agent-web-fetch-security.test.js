'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  executeAgentWebFetch,
} = require('../src/services/agent-harness/tools/web-fetch-tool');

function textResponse(body, {
  status = 200,
  contentType = 'text/plain',
  location = null,
} = {}) {
  const bytes = new TextEncoder().encode(body);
  let read = false;
  return {
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType;
        if (String(name).toLowerCase() === 'location') return location;
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
      async cancel() {},
    },
    async text() {
      return body;
    },
  };
}

test('agent web fetch rejects credentials, IP literals and non-web ports before network I/O', async () => {
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    return textResponse('unexpected');
  };

  await assert.rejects(
    () => executeAgentWebFetch({ url: 'https://user:secret@example.com/' }, { fetch }),
    { code: 'web_fetch_credentials_rejected' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'http://169.254.169.254/latest/meta-data/' }, { fetch }),
    { code: 'web_fetch_blocked_host' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'http://100.100.100.200/latest/meta-data/' }, { fetch }),
    { code: 'web_fetch_blocked_host' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'http://225.1.2.3/' }, { fetch }),
    { code: 'web_fetch_blocked_host' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'http://[fe90::1]/' }, { fetch }),
    { code: 'web_fetch_blocked_host' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'https://8.8.8.8/' }, { fetch }),
    { code: 'web_fetch_ip_literal_rejected' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'https://example.com:6379/' }, { fetch }),
    { code: 'web_fetch_nonstandard_port_rejected' },
  );
  await assert.rejects(
    () => executeAgentWebFetch({ url: 'http://example.com:8080/' }, { fetch }),
    { code: 'web_fetch_nonstandard_port_rejected' },
  );
  assert.equal(fetchCalls, 0);
});

test('agent web fetch blocks mixed public/private DNS answers before fetch', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => executeAgentWebFetch(
      { url: 'https://rebind.example/' },
      {
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.7', family: 4 },
        ],
        fetch: async () => {
          fetchCalls += 1;
          return textResponse('unexpected');
        },
      },
    ),
    { code: 'web_fetch_resolved_blocked' },
  );
  assert.equal(fetchCalls, 0);
});

test('agent web fetch pins every validated redirect host into its dispatcher', async () => {
  const lookups = [];
  const dispatchers = [];
  const fetches = [];
  const closed = [];

  const result = await executeAgentWebFetch(
    { url: 'https://tesis20.com/', maxChars: 2000 },
    {
      lookup: async (hostname) => {
        lookups.push(hostname);
        return [{ address: hostname === 'tesis20.com' ? '76.76.21.21' : '76.76.21.22', family: 4 }];
      },
      createDispatcher: (hostname, records) => {
        dispatchers.push({ hostname, records });
        return { hostname, close: async () => { closed.push(hostname); } };
      },
      fetch: async (url, options) => {
        fetches.push({ url, options });
        if (url === 'https://tesis20.com/') {
          return textResponse('', {
            status: 308,
            contentType: 'text/plain',
            location: 'https://www.tesis20.com/',
          });
        }
        return textResponse('Asesoría y acompañamiento para tu tesis');
      },
    },
  );

  assert.deepEqual(lookups, ['tesis20.com', 'www.tesis20.com']);
  assert.deepEqual(dispatchers.map((entry) => entry.hostname), ['tesis20.com', 'www.tesis20.com']);
  assert.equal(fetches[0].options.dispatcher.hostname, 'tesis20.com');
  assert.equal(fetches[1].options.dispatcher.hostname, 'www.tesis20.com');
  assert.deepEqual(fetches[0].options.pinnedAddresses, [{ address: '76.76.21.21', family: 4 }]);
  assert.deepEqual(fetches[1].options.pinnedAddresses, [{ address: '76.76.21.22', family: 4 }]);
  assert.deepEqual(closed.sort(), ['tesis20.com', 'www.tesis20.com']);
  assert.equal(result.finalUrl, 'https://www.tesis20.com/');
  assert.match(result.text, /Asesoría y acompañamiento/);
});
