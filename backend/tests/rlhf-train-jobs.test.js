'use strict';

/**
 * RLHF phase 3 — admin SFT/DPO prep jobs.
 * Flagged off by default. Prep-only. No PII in logs or job.result.
 */

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
process.env.SIRAGPT_RLHF_ENABLED = '1';
process.env.SIRAGPT_RLHF_BEST_OF_N = '0';
delete process.env.AGENTES_CODING_V2;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { describe, it, beforeEach, afterEach } = require('node:test');

const store = require('../src/services/rlhf/preference-store');
const trainer = require('../src/services/rlhf/trainer');
const metrics = require('../src/services/rlhf/metrics');
const flags = require('../src/services/rlhf/flags');
const { processTrainJob, summarisePiiHits, TrainJobError } = require('../src/services/rlhf/train-processor');
const trainSubmit = require('../src/services/rlhf/train-submit');
const {
  createTrainJobQueue,
  filterDigest,
  JOB_STATUS,
} = require('../src/services/rlhf/train-jobs');
function mockResolvedModule(resolvedPath, exports) {
  const original = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
  return () => {
    if (original) require.cache[resolvedPath] = original;
    else delete require.cache[resolvedPath];
  };
}

function reloadModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

function request(app, { method = 'GET', path: urlPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const headers = { Accept: 'application/json' };
      const payload = body == null ? undefined : JSON.stringify(body);
      if (payload) headers['Content-Type'] = 'application/json';
      http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      }).end(payload);
    });
  });
}

function memoryPrisma() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    rlhfTrainJob: {
      async create({ data }) {
        const row = {
          id: `job_${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          finishedAt: null,
          error: null,
          result: null,
          ...data,
        };
        rows.push(row);
        return { ...row };
      },
      async findFirst({ where } = {}) {
        return rows.find((r) => {
          if (where?.id && r.id !== where.id) return false;
          if (where?.createdById && r.createdById !== where.createdById) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          if (where?.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
          return true;
        }) || null;
      },
      async findMany({ where, orderBy, take } = {}) {
        let out = rows.slice();
        if (where?.status?.in) out = out.filter((r) => where.status.in.includes(r.status));
        if (orderBy?.createdAt === 'desc') out.sort((a, b) => b.createdAt - a.createdAt);
        if (take) out = out.slice(0, take);
        return out.map((r) => ({ ...r }));
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('missing');
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows) {
          if (where?.status?.in && !where.status.in.includes(row.status)) continue;
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      },
      async count({ where } = {}) {
        return rows.filter((r) => {
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        }).length;
      },
    },
  };
}

async function seedPair(userId = 'u1') {
  const prompt = 'explica DPO en una frase';
  await store.recordEvent({
    userId, runId: `${userId}-w`, promptText: prompt, responseText: 'DPO alinea sin PPO',
    label: 'chosen', source: 'pairwise', agent: 'chat',
  });
  await store.recordEvent({
    userId, runId: `${userId}-l`, promptText: prompt, responseText: 'no sé',
    label: 'rejected', source: 'pairwise', agent: 'chat',
  });
}

beforeEach(() => {
  store._reset();
  trainer._reset();
  metrics.reset();
  delete process.env.SIRAGPT_RLHF_TRAIN_JOBS;
  delete process.env.SIRAGPT_RLHF_TRAIN_SUBMIT;
});

describe('flags', () => {
  it('train jobs and submit stay OFF unless explicitly enabled', () => {
    delete process.env.SIRAGPT_RLHF_TRAIN_JOBS;
    delete process.env.SIRAGPT_RLHF_TRAIN_SUBMIT;
    assert.equal(flags.isTrainJobsEnabled(), false);
    assert.equal(flags.isTrainSubmitEnabled(), false);
    process.env.SIRAGPT_RLHF_TRAIN_JOBS = '0';
    process.env.SIRAGPT_RLHF_TRAIN_SUBMIT = 'false';
    assert.equal(flags.isTrainJobsEnabled(), false);
    assert.equal(flags.isTrainSubmitEnabled(), false);
    process.env.SIRAGPT_RLHF_TRAIN_JOBS = '1';
    process.env.SIRAGPT_RLHF_TRAIN_SUBMIT = 'on';
    assert.equal(flags.isTrainJobsEnabled(), true);
    assert.equal(flags.isTrainSubmitEnabled(), true);
  });

  it('AUTO_TRAIN does not imply train jobs or submit', () => {
    process.env.SIRAGPT_RLHF_AUTO_TRAIN = '1';
    delete process.env.SIRAGPT_RLHF_TRAIN_JOBS;
    assert.equal(flags.isAutoTrainEnabled(), true);
    assert.equal(flags.isTrainJobsEnabled(), false);
  });
});

describe('processor', () => {
  it('builds a scrubbed SFT artifact and never keeps the raw email', async () => {
    await store.recordEvent({
      userId: 'u1', runId: 'p', promptText: 'mail me at ada@example.com',
      responseText: 'sure, ada@example.com', label: 'chosen', source: 'explicit',
    });
    let captured = '';
    const out = await processTrainJob({
      jobId: 'job_sft',
      format: 'sft',
      minPairs: 1,
      persistJsonl: async ({ ndjson }) => {
        captured = ndjson;
        return {
          storage: 'local',
          key: 'rlhf-train/job_sft/sft.jsonl',
          ref: '/tmp/sft.jsonl',
          localPath: '/tmp/sft.jsonl',
          bytes: Buffer.byteLength(ndjson),
          sha256: 'abc',
        };
      },
    });
    assert.equal(out.count, 1);
    assert.doesNotMatch(captured, /ada@example.com/);
    assert.match(captured, /<EMAIL>/);
    assert.equal(out.piiHits.count >= 1, true);
    assert.ok(out.piiHits.kinds.email);
    assert.equal(out.submit.submitted, false);
    assert.ok(!JSON.stringify(out).includes('ada@example.com'));
  });

  it('human-only filter drops RLAIF rows unless includeRlaif is set', async () => {
    await store.recordEvent({
      userId: 'u1', runId: 'h', promptText: 'q', responseText: 'human',
      label: 'chosen', source: 'explicit',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'a', promptText: 'q2', responseText: 'synthetic-rlaif',
      label: 'chosen', source: 'rlaif',
    });
    let captured = '';
    const human = await processTrainJob({
      jobId: 'job_h',
      format: 'sft',
      includeRlaif: false,
      persistJsonl: async ({ ndjson }) => {
        captured = ndjson;
        return { storage: 'local', key: 'k', ref: 'k', localPath: 'k', bytes: 1, sha256: 'x' };
      },
    });
    assert.equal(human.count, 1);
    assert.match(captured, /human/);
    assert.doesNotMatch(captured, /synthetic-rlaif/);

    const mixed = await processTrainJob({
      jobId: 'job_m',
      format: 'sft',
      includeRlaif: true,
      persistJsonl: async ({ ndjson }) => {
        captured = ndjson;
        return { storage: 'local', key: 'k', ref: 'k', localPath: 'k', bytes: 1, sha256: 'x' };
      },
    });
    assert.equal(mixed.count, 2);
    assert.match(captured, /synthetic-rlaif/);
  });

  it('fails with E_PARAMS when below minPairs', async () => {
    await seedPair();
    await assert.rejects(
      () => processTrainJob({
        format: 'dpo',
        minPairs: 5,
        persistJsonl: async () => { throw new Error('should not persist'); },
      }),
      (err) => err instanceof TrainJobError && err.code === 'E_PARAMS',
    );
  });

  it('summarisePiiHits never copies raw values', () => {
    const summary = summarisePiiHits([
      { id: 'email', count: 2 },
      { id: 'email', count: 1 },
      { id: 'phone', count: 1 },
    ]);
    assert.equal(summary.count, 4);
    assert.equal(summary.kinds.email, 3);
    assert.deepEqual(Object.keys(summary.kinds).sort(), ['email', 'phone']);
  });
});

describe('submit adapter', () => {
  it('resolves no catalog adapter and never mentions a third-party aggregator', () => {
    process.env.SIRAGPT_RLHF_TRAIN_SUBMIT = '1';
    assert.equal(trainSubmit.resolveCatalogFineTuneAdapter(), null);
    assert.equal(trainSubmit.isSubmitAvailable(), false);
    const src = fs.readFileSync(path.join(__dirname, '../src/services/rlhf/train-submit.js'), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*openrouter/i);
    assert.doesNotMatch(src, /deepseek/i);
    assert.match(src, /Sira Rápido/);
    assert.match(src, /Sira Pro/);
  });
});

describe('queue create/status', () => {
  it('flag off rejects enqueue with E_DISABLED', async () => {
    const client = memoryPrisma();
    const queue = createTrainJobQueue({ client, env: { ...process.env, SIRAGPT_RLHF_TRAIN_JOBS: '0' } });
    await assert.rejects(
      () => queue.enqueue({ createdById: 'admin', format: 'sft' }),
      (err) => err.code === 'E_DISABLED',
    );
    assert.equal(client.rows.length, 0);
  });

  it('creates a job, reaches ready, and hides private paths on get', async () => {
    await seedPair();
    const client = memoryPrisma();
    const env = { ...process.env, SIRAGPT_RLHF_TRAIN_JOBS: '1' };
    const captured = [];
    const queue = createTrainJobQueue({
      client,
      env,
      processor: (spec, ctx) => processTrainJob({
        ...spec,
        persistJsonl: async ({ ndjson, format, jobId }) => {
          captured.push({ format, jobId, ndjson });
          return {
            storage: 'local',
            key: `rlhf-train/${jobId}/${format}.jsonl`,
            ref: `/secret/box/${jobId}.jsonl`,
            localPath: `/secret/box/${jobId}.jsonl`,
            bytes: Buffer.byteLength(ndjson),
            sha256: 'deadbeef',
          };
        },
      }, ctx),
    });
    const created = await queue.enqueue({
      createdById: 'admin-1',
      format: 'dpo',
      minPairs: 1,
      includeRlaif: false,
    });
    assert.equal(created.status, JOB_STATUS.QUEUED);
    assert.equal(created.format, 'dpo');
    await queue.drain();
    const job = await queue.get(created.id);
    assert.equal(job.status, JOB_STATUS.READY);
    assert.equal(job.result.count, 1);
    assert.equal(job.result.storage, 'local');
    assert.ok(job.result.downloadPath.includes(created.id));
    assert.equal(job.result.__private, undefined);
    assert.ok(!JSON.stringify(job).includes('/secret/box'));
    const listed = await queue.list({ limit: 5 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
  });

  it('user scope without scopeUserId is E_PARAMS', async () => {
    const queue = createTrainJobQueue({
      client: memoryPrisma(),
      env: { ...process.env, SIRAGPT_RLHF_TRAIN_JOBS: '1' },
    });
    await assert.rejects(
      () => queue.enqueue({ createdById: 'admin', format: 'sft', scope: 'user' }),
      (err) => err.code === 'E_PARAMS',
    );
  });

  it('idempotency returns the same job for an identical payload within 60s', async () => {
    await store.recordEvent({
      userId: 'u1', runId: 'x', promptText: 'q', responseText: 'a',
      label: 'chosen', source: 'explicit',
    });
    const client = memoryPrisma();
    const env = { ...process.env, SIRAGPT_RLHF_TRAIN_JOBS: '1' };
    const queue = createTrainJobQueue({
      client,
      env,
      processor: async () => ({ count: 1, bytes: 2, storage: 'local', artifactKey: 'k' }),
    });
    const a = await queue.enqueue({ createdById: 'admin', format: 'sft', minPairs: 1 });
    const b = await queue.enqueue({ createdById: 'admin', format: 'sft', minPairs: 1 });
    assert.equal(a.id, b.id);
    assert.equal(client.rows.length, 1);
    await queue.drain();
  });
});

function canLoadHttpRoute() {
  try {
    require('express');
    require('express-validator');
    return true;
  } catch {
    return false;
  }
}

(canLoadHttpRoute() ? describe : describe.skip)('HTTP /api/rlhf/jobs', () => {
  let restoreAuth;
  let restoreJobs;
  let app;
  const jobs = [];

  beforeEach(() => {
    jobs.length = 0;
    restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => {
        req.user = { id: 'admin-1', isAdmin: true, isSuperAdmin: false };
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user || (!req.user.isAdmin && !req.user.isSuperAdmin)) {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      },
    });
    restoreJobs = mockResolvedModule(require.resolve('../src/services/rlhf/train-jobs'), {
      isTrainJobsEnabled: () => process.env.SIRAGPT_RLHF_TRAIN_JOBS === '1',
      isTrainSubmitEnabled: () => process.env.SIRAGPT_RLHF_TRAIN_SUBMIT === '1',
      TrainJobError,
      getTrainJobQueue: () => ({
        async enqueue(spec) {
          if (process.env.SIRAGPT_RLHF_TRAIN_JOBS !== '1') {
            const err = new TrainJobError('E_DISABLED', 'RLHF train jobs are disabled', 403);
            throw err;
          }
          const job = {
            id: `job_${jobs.length + 1}`,
            status: 'queued',
            stage: 'Encolado',
            format: spec.format,
            includeRlaif: !!spec.includeRlaif,
            minPairs: spec.minPairs || 1,
            scope: spec.scope || 'global',
            result: null,
          };
          jobs.push(job);
          return job;
        },
        async get(id) { return jobs.find((j) => j.id === id) || null; },
        async getRow(id) { return jobs.find((j) => j.id === id) || null; },
        async list() { return jobs.slice(); },
      }),
    });
    const express = require('express');
    const router = reloadModule('../src/routes/rlhf');
    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/rlhf', router);
  });

  afterEach(() => {
    restoreAuth();
    restoreJobs();
    delete require.cache[require.resolve('../src/routes/rlhf')];
  });

  it('POST /jobs is 403 when the flag is off', async () => {
    delete process.env.SIRAGPT_RLHF_TRAIN_JOBS;
    const res = await request(app, { method: 'POST', path: '/api/rlhf/jobs', body: { format: 'sft' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'E_DISABLED');
    assert.equal(jobs.length, 0);
  });

  it('POST /jobs creates and GET /jobs/:id returns status', async () => {
    process.env.SIRAGPT_RLHF_TRAIN_JOBS = '1';
    const created = await request(app, {
      method: 'POST',
      path: '/api/rlhf/jobs',
      body: { format: 'sft', includeRlaif: false, minPairs: 8 },
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.job.format, 'sft');
    assert.equal(created.body.job.includeRlaif, false);
    const id = created.body.job.id;
    const listed = await request(app, { path: '/api/rlhf/jobs' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.jobs.length, 1);
    const got = await request(app, { path: `/api/rlhf/jobs/${id}` });
    assert.equal(got.status, 200);
    assert.equal(got.body.job.id, id);
    assert.equal(got.body.job.status, 'queued');
  });

  it('rejects non-admin callers', async () => {
    restoreAuth();
    restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => {
        req.user = { id: 'user-1', isAdmin: false, isSuperAdmin: false };
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user || (!req.user.isAdmin && !req.user.isSuperAdmin)) {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      },
    });
    process.env.SIRAGPT_RLHF_TRAIN_JOBS = '1';
    delete require.cache[require.resolve('../src/routes/rlhf')];
    const express = require('express');
    const router = reloadModule('../src/routes/rlhf');
    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/rlhf', router);
    const res = await request(app, { method: 'POST', path: '/api/rlhf/jobs', body: { format: 'sft' } });
    assert.equal(res.status, 403);
  });
});

describe('source contracts', () => {
  const root = path.join(__dirname, '..');

  it('AUTO_TRAIN only calls the local RM trainer', () => {
    const src = fs.readFileSync(path.join(root, 'src/services/rlhf/preference-store.js'), 'utf8');
    assert.match(src, /maybeRetrain/);
    assert.doesNotMatch(src, /getTrainJobQueue/);
    assert.doesNotMatch(src, /processTrainJob/);
  });

  it('does not enable BEST_OF_N or AGENTES_CODING_V2', () => {
    const files = [
      'src/routes/rlhf.js',
      'src/services/rlhf/train-jobs.js',
      'src/services/rlhf/train-processor.js',
      'src/services/rlhf/flags.js',
      'index.js',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(src, /SIRAGPT_RLHF_BEST_OF_N\s*=\s*['"]1['"]/);
      assert.doesNotMatch(src, /AGENTES_CODING_V2\s*=\s*['"]1['"]/);
    }
  });

  it('job routes stay admin + flagged and never mention a vendor model id', () => {
    const src = fs.readFileSync(path.join(root, 'src/routes/rlhf.js'), 'utf8');
    assert.match(src, /router\.post\(\s*'\/jobs'/);
    assert.match(src, /requireAdmin/);
    assert.match(src, /isTrainJobsEnabled/);
    assert.doesNotMatch(src, /OpenRouter/i);
    assert.doesNotMatch(src, /deepseek/i);
    assert.doesNotMatch(src, /model_id/);
  });

  it('digest is stable for the same filters', () => {
    const a = filterDigest({ format: 'sft', includeRlaif: false, minPairs: 8, scope: 'global', scrubPii: true });
    const b = filterDigest({ format: 'sft', includeRlaif: false, minPairs: 8, scope: 'global', scrubPii: true });
    assert.equal(a, b);
  });
});

describe('local persist fallback', () => {
  it('writes JSONL under uploads/rlhf-train without logging contents', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlhf-train-'));
    try {
      await store.recordEvent({
        userId: 'u1', runId: 'p', promptText: 'hola', responseText: 'hola!',
        label: 'chosen', source: 'explicit',
      });
      const { persistJsonl } = require('../src/services/rlhf/train-processor');
      const stored = await persistJsonl({
        jobId: 'job_local',
        format: 'sft',
        ndjson: '{"messages":[]}\n',
        env: { UPLOAD_DIR: tmp },
        storage: { persistLocalFile: async ({ localPath, key }) => ({ key, ref: localPath, storage: 'local' }) },
      });
      assert.equal(stored.storage, 'local');
      assert.ok(fs.existsSync(stored.localPath));
      assert.match(stored.key, /rlhf-train\/job_local\/sft\.jsonl/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
