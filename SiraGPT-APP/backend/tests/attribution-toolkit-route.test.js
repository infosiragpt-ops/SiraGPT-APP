'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const router = require('../src/routes/attribution-toolkit');
const rollup = require('../src/services/attribution-rollup-aggregator');

function requestJson(server, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload ? Buffer.byteLength(payload) : 0,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(handler, { user = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (user) {
    // Simulate an authenticated request the way optionalAuth would populate it.
    app.use((req, _res, next) => { req.user = user; next(); });
  }
  app.use('/api/attribution-toolkit', router);
  const server = app.listen(0);
  try { await handler(server); }
  finally { await new Promise((r) => server.close(r)); }
}

test('GET /health returns module map + counts', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-toolkit/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.modules.anomaly);
    assert.ok(r.body.modules.rollup);
    assert.ok(r.body.counts);
  });
});

test('POST /anomaly/observe + /anomaly/score round-trip', async () => {
  await withServer(async (server) => {
    const profile = { centroid: { feature: 0.6, intent: 0.2 }, dominantIntentKind: 'build', featureCount: 5 };
    const observe = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/anomaly/observe',
      body: { profile },
    });
    assert.strictEqual(observe.status, 200);
    assert.strictEqual(observe.body.ok, true);
    const score = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/anomaly/score',
      body: { profile },
    });
    assert.strictEqual(score.status, 200);
    assert.ok(score.body.score >= 0);
  }, { user: { id: 'route-test' } });
});

test('POST /anomaly/observe rejects missing userId', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/anomaly/observe',
      body: { profile: { centroid: { feature: 0.5 } } },
    });
    assert.strictEqual(r.status, 400);
  });
});

test('IDOR: anonymous caller-supplied userId does not read/poison another user’s telemetry', async () => {
  await withServer(async (server) => {
    // Anonymous observe with ?userId=victim in query + body must be rejected (400),
    // never attributing to the victim's anomaly baseline.
    const observe = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/anomaly/observe?userId=victim',
      body: { userId: 'victim', profile: { centroid: { feature: 0.9 } } },
    });
    assert.strictEqual(observe.status, 400);

    // Anonymous baseline read with ?userId=victim must be rejected too.
    const baseline = await requestJson(server, {
      method: 'GET',
      path: '/api/attribution-toolkit/anomaly/baseline?userId=victim',
    });
    assert.strictEqual(baseline.status, 400);

    // Anonymous rollup/record with a spoofed userId must not attribute the
    // sample to the victim — it is recorded unattributed (userId null).
    rollup.__resetForTests();
    const rec = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/rollup/record?userId=victim',
      body: { userId: 'victim', domain: 'legal', turnId: 'spoof' },
    });
    assert.strictEqual(rec.status, 200);
    // The sample exists but is NOT scoped to the victim.
    const victimRollup = rollup.rollup({ scope: 'user', userId: 'victim' });
    assert.strictEqual(victimRollup.samples, 0);
    rollup.__resetForTests();
  });
  // no injected user → anonymous
});

test('POST /rollup/record + GET /rollup round-trip', async () => {
  await withServer(async (server) => {
    const rec = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/rollup/record',
      body: { faithfulness: 0.8, primaryIntent: 'build' },
    });
    assert.strictEqual(rec.status, 200);
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-toolkit/rollup?scope=user' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.samples >= 1);
    assert.strictEqual(r.body.userId, 'u');
  }, { user: { id: 'u' } });
});

test('GET /rollup/recent returns recent samples', async () => {
  await withServer(async (server) => {
    for (let i = 0; i < 5; i += 1) {
      await requestJson(server, {
        method: 'POST',
        path: '/api/attribution-toolkit/rollup/record',
        body: { turnId: `t${i}` },
      });
    }
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-toolkit/rollup/recent?limit=3' });
    assert.ok(Array.isArray(r.body.samples));
    assert.ok(r.body.samples.length <= 3);
  }, { user: { id: 'u' } });
});

test('POST /fuzzer/variants returns variants', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/fuzzer/variants',
      body: { prompt: 'Please build me a chart of revenue.' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.variants));
    assert.ok(r.body.variants.length >= 2);
  });
});

test('POST /fuzzer/stability uses surrogate scorer', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/fuzzer/stability',
      body: { prompt: 'Audit the contract clause for liability.' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.ok);
    assert.ok(['robust', 'mostly_stable', 'fragile'].includes(r.body.classification));
  });
});

test('POST /cross-modal/attribute returns citations', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/cross-modal/attribute',
      body: {
        regions: [{ id: 'r1', fileName: 'doc.pdf', kind: 'pdf', location: { page: 1 },
          text: 'Backend deployment uses Postgres.' }],
        response: 'The backend deployment uses Postgres.',
      },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.citations));
  });
});

test('POST /domain/detect returns calibration', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/domain/detect',
      body: { text: 'Review the contract clause for liability and compliance.' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.domain, 'legal');
    assert.ok(r.body.faithfulnessAcceptThreshold > 0.5);
  });
});

test('GET /domain/list returns every supported domain', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-toolkit/domain/list' });
    assert.strictEqual(r.status, 200);
    const domains = r.body.domains.map((d) => d.domain);
    for (const expected of ['legal', 'medical', 'financial', 'code', 'creative', 'general']) {
      assert.ok(domains.includes(expected));
    }
  });
});

test('POST /reflection returns a verdict', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/reflection',
      body: { draft: 'A short answer.', faithfulnessScore: { score: 0.4 } },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(['accept', 'retry_soft', 'retry_strict', 'escalate'].includes(r.body.verdict));
  });
});

test('POST /visualize/mermaid returns mermaid text', async () => {
  await withServer(async (server) => {
    const graph = {
      nodes: [
        { id: 'i', type: 'input', text: 'msg' },
        { id: 'in', type: 'intent', text: 'build' },
      ],
      edges: [{ from: 'i', to: 'in', weight: 0.7 }],
    };
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/visualize/mermaid',
      body: { graph },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.mermaid.includes('flowchart'));
  });
});

test('POST /compare/graphs returns diff report', async () => {
  await withServer(async (server) => {
    const g1 = { nodes: [{ id: 'a', type: 'input' }], edges: [] };
    const g2 = { nodes: [{ id: 'a', type: 'input' }, { id: 'b', type: 'feature' }], edges: [] };
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/compare/graphs',
      body: { graphA: g1, graphB: g2 },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.nodesAdded.length >= 1);
    assert.ok(typeof r.body.summary === 'string');
  });
});

test('GET /perf/aggregate returns stats array or single', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-toolkit/perf/aggregate' });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.stats) || typeof r.body.stats === 'object');
  });
});

test('POST /perf/reset clears stats', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-toolkit/perf/reset',
      body: {},
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });
});
