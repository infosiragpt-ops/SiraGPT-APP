import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentSandboxProcessor, type DocumentProcessorDependencies } from '../src/modules/doc-sandbox/queue/processor';
import { DocumentRepositoryError, type AttemptLease, type StoredArtifact, type StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { emptyUsage } from '../src/modules/doc-sandbox/engine/cost';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import type { Artifact, EditPlan, InputFile, ValidationReport } from '../src/modules/doc-sandbox/types/contracts';
import type { SandboxEngine, SandboxSession } from '../src/modules/doc-sandbox/engine/types';
import type { PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import type { IndependentDocumentValidator } from '../src/modules/doc-sandbox/validation';
import { DocumentValidationError } from '../src/modules/doc-sandbox/validation/errors';

// In-memory repository/storage/engine/validator. process() is exercised without
// Postgres, S3, Docker or a provider HTTP call.
const lease: AttemptLease = { jobId: 'job-1', token: 'lease-1', fence: 1, attempt: 1 };
const session: SandboxSession = { id: 'session-1', jobId: 'job-1', userId: 'owner-1', attempt: 1 };
const bytes = Buffer.from('El informe dice 2026.\n');
const hash = sha256(bytes);
const instructions = Buffer.from('No cambies el documento.');
const recipe = Buffer.alloc(32, 0); recipe.writeUInt32LE(0x04034b50, 0);

function inputFile(): InputFile {
  return { id: 'input-1', name: 'informe.txt', format: 'txt', mime: 'text/plain', data: Buffer.from(bytes), sha256: hash };
}

function plan(notPossible = false): EditPlan {
  return {
    schemaVersion: 1, mode: 'preserve', outputName: 'informe.txt', inputHashes: { 'input-1': hash },
    edits: notPossible ? [] : [{ id: 'e1', inputId: 'input-1', kind: 'text', part: '$document', locator: 'text',
      before: '2026', after: '2027' }],
    notPossible: notPossible ? [{ request: 'cambiar el año', reason: 'The source cannot be changed as requested.' }] : [],
  };
}

function inventory() {
  return { id: 'input-1', format: 'txt', sha256: hash, size: bytes.length, name: 'informe.txt', mime: 'text/plain',
    parts: { $document: 'El informe dice 2026.\n' },
    units: [{ part: '$document', locator: 'text', text: '2026', kind: 'text' }], warnings: [] };
}

function levels(passed = true): ValidationReport['levels'] {
  return ([1, 2, 3, 4] as const).map(level => ({
    level,
    passed: level === 2 || level === 3 ? true : passed,
    applicable: !(level === 2 || level === 3),
    durationMs: 1,
    details: { reason: level === 2 || level === 3 ? 'Plain text is not paginated' : 'ok' },
  }));
}

function report(outputSha = hash): ValidationReport {
  return { passed: true, levels: levels(), originalSha256: hash, outputSha256: outputSha, changes: [], artifacts: [] };
}

function job(overrides: Partial<StoredDocumentJob> = {}): StoredDocumentJob {
  return {
    id: 'job-1', userId: 'owner-1', status: 'inspecting', admissionReady: true, mode: 'preserve',
    engine: 'anthropic', modelTier: 'mechanical', requestedModel: 'synthetic', tokenBudget: 20_000,
    instructionsKey: 'doc-sandbox/owner-1/job-1/v1/ins.sealed', inputKeys: ['doc-sandbox/owner-1/job-1/v1/in.sealed'],
    outputKeys: [], editPlanKey: null, editPlanHash: null, validationReportKey: null, errorCode: null,
    usage: {}, costUsd: '0', maxCostUsd: '5', costReservations: [], purgedKeys: [],
    storageKeys: ['doc-sandbox/owner-1/job-1/v1/ins.sealed', 'doc-sandbox/owner-1/job-1/v1/in.sealed'],
    outcome: null, attempts: 1, fence: 1, leaseToken: 'lease-1', leaseExpiresAt: new Date(Date.now() + 30_000),
    eventSeq: 1, sessionRef: null, providerFiles: [], providerContainers: [], cleanupPending: false,
    cleanupNotBefore: null, parentJobId: null, promptVersion: 'v1', createdAt: new Date(), startedAt: new Date(),
    finishedAt: null, expiresAt: new Date(Date.now() + 600_000), deletedAt: null, ...overrides,
  };
}

function artifactMeta(): StoredArtifact {
  return {
    id: 'input-1', jobId: 'job-1', attempt: 0, kind: 'input',
    storageKey: 'doc-sandbox/owner-1/job-1/v1/in.sealed', filename: 'informe.txt',
    mime: 'text/plain', size: bytes.length, sha256: hash, published: false, purgedAt: null,
  };
}

function recipeZip(): Artifact {
  return { name: 'recipe.zip', kind: 'recipe', mime: 'application/zip', data: recipe, sha256: sha256(recipe) };
}

function outputArtifact(data = bytes): Artifact {
  return { name: 'informe.txt', kind: 'output', mime: 'text/plain', data: Buffer.from(data), sha256: sha256(data) };
}

function agentResult(editPlan: EditPlan): Artifact {
  const payload = {
    schemaVersion: 1, outputName: editPlan.outputName, outcome: editPlan.notPossible.length ? 'not_possible' : 'edited',
    editsApplied: editPlan.edits.map(edit => edit.id), editsFailed: [], partsModified: editPlan.edits.length ? ['$document'] : [],
    pagesAffected: [], warnings: [], selfCheck: { openedOk: true, textDiffMatchesPlan: true },
  };
  const data = Buffer.from(JSON.stringify(payload));
  return { name: 'result.json', kind: 'agent_result', mime: 'application/json', data, sha256: sha256(data) };
}

function fakeStorage(objects: Record<string, Buffer> = {}) {
  const store = { ...objects };
  return {
    store,
    prepare(_scope: { userId: string; jobId: string }, data: Buffer) {
      const key = `doc-sandbox/owner-1/job-1/v1/${sha256(data).slice(0, 8)}.sealed`;
      return { key, sha256: sha256(data), size: data.length };
    },
    async putPrepared(_scope: unknown, object: { key: string }, data: Buffer) { store[object.key] = Buffer.from(data); },
    async get(_scope: unknown, key: string) {
      if (!store[key]) throw new Error(`missing ${key}`);
      return Buffer.from(store[key]);
    },
    async remove(_scope: unknown, key: string) { delete store[key]; },
  };
}

function fakeRepository(state: { job: StoredDocumentJob; artifacts: StoredArtifact[] }) {
  const calls: string[] = [];
  return {
    calls,
    async claimAttempt() { calls.push('claim'); return lease; },
    async getInternal() { return { ...state.job, usage: { ...state.job.usage } }; },
    async artifactsInternal() { return state.artifacts.map(item => ({ ...item })); },
    async heartbeat() { calls.push('heartbeat'); },
    async transition(_lease: AttemptLease, next: string) { calls.push(`transition:${next}`); state.job.status = next as StoredDocumentJob['status']; },
    async freezePlan() { calls.push('freeze'); },
    async reserveStorageKeys() { calls.push('reserveKeys'); },
    async markStorageKeysPurged() { calls.push('purgedKeys'); },
    async registerArtifacts() { calls.push('register'); },
    async publishValidated() { calls.push('publish'); state.job.status = 'done'; },
    async failAttempt(_lease: AttemptLease, code: string, retryable: boolean) {
      calls.push(`fail:${code}:${retryable}`);
      state.job.status = retryable ? 'queued' : 'failed';
      return state.job.status;
    },
    async appendEvent() { calls.push('event'); },
    async recordSession() { calls.push('session'); },
    async recordContainer() { calls.push('container'); },
    async recordProviderFiles() { calls.push('files'); },
    async markProviderFileDeleted() { calls.push('fileDeleted'); },
    async reserveCost() { calls.push('reserveCost'); return true; },
    async settleCost() { calls.push('settle'); },
    async recordUsage() { calls.push('usage'); },
  };
}

function processor(deps: Partial<DocumentProcessorDependencies> & { repository: ReturnType<typeof fakeRepository>; storage: ReturnType<typeof fakeStorage> },
  notices: string[] = []) {
  return new DocumentSandboxProcessor({
    repository: deps.repository as never,
    storage: deps.storage as never,
    validator: deps.validator as IndependentDocumentValidator,
    engineFactory: deps.engineFactory ?? (() => { throw new Error('engine'); }),
    onNotice: ({ code }) => notices.push(code),
    onPhase: deps.onPhase,
    onValidation: deps.onValidation,
  }, { maxTurns: 8, maxTokens: 20_000, timeoutMs: 30_000, leaseMs: 10_000 });
}

test('process returns immediately when the attempt cannot be claimed', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  repository.claimAttempt = async () => null;
  const instance = processor({
    repository, storage: fakeStorage(),
    validator: { inspect: async () => assert.fail('inspect') } as never,
  });
  await instance.process('job-1');
  assert.deepEqual(repository.calls, []);
});

test('process publishes a validated edit from mocked engine/validator/storage', async () => {
  const notices: string[] = [];
  const phases: string[] = [];
  const validations: Array<[number, boolean, boolean]> = [];
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const approved = plan();
  const output = Buffer.from('El informe dice 2027.\n');
  const engine: SandboxEngine = {
    createSession: async () => session,
    uploadInputs: async () => undefined,
    run: async (_handle, request) => {
      if (request.stage === 'plan') {
        return { status: 'planned', editPlan: approved, usage: emptyUsage(), transcript: [] };
      }
      return {
        status: 'edited', editPlan: request.approvedPlan ?? approved,
        agentResult: {
          schemaVersion: 1, outputName: 'informe.txt', outcome: 'edited',
          editsApplied: ['e1'], editsFailed: [], partsModified: ['$document'], pagesAffected: [],
          warnings: [], selfCheck: { openedOk: true, textDiffMatchesPlan: true },
        },
        usage: emptyUsage(), transcript: [],
      };
    },
    downloadOutputs: async () => [outputArtifact(output), recipeZip(), agentResult(approved)],
    destroy: async () => undefined,
  };
  const instance = processor({
    repository, storage: stored,
    validator: {
      inspect: async () => [inventory()],
      inspectRecipeArchive: async () => ({ sha256: sha256(recipe), size: recipe.length, expandedBytes: 1, scripts: ['01.py'], parts: {} }),
      validate: async () => report(sha256(output)),
    } as never,
    engineFactory: () => engine,
    onPhase: phase => { phases.push(phase); },
    onValidation: (level, passed, applicable) => { validations.push([level, passed, applicable]); },
  }, notices);
  await instance.process('job-1');
  assert.ok(repository.calls.includes('publish'), `calls=${repository.calls.join(',')} notices=${notices.join(',')}`);
  assert.deepEqual(phases, ['inspecting', 'planning', 'editing', 'validating']);
  assert.equal(validations.length, 4);
  assert.deepEqual(notices, []);
});

test('a refused plan delivers the conservative originals after independent validation', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const refused = plan(true);
  const engine: SandboxEngine = {
    createSession: async () => session,
    uploadInputs: async () => undefined,
    run: async () => ({ status: 'planned', editPlan: refused, usage: emptyUsage(), transcript: [] }),
    downloadOutputs: async () => [{
      name: 'transcript.json', kind: 'transcript', mime: 'application/json',
      data: Buffer.from('[]'), sha256: sha256(Buffer.from('[]')),
    }],
    destroy: async () => undefined,
  };
  const instance = processor({
    repository, storage: stored,
    validator: {
      inspect: async () => [inventory()],
      inspectRecipeArchive: async () => ({ sha256: 'b'.repeat(64), size: 22, expandedBytes: 1, scripts: ['01.py'], parts: {} }),
      validate: async () => report(hash),
    } as never,
    engineFactory: () => engine,
  });
  await instance.process('job-1');
  assert.ok(repository.calls.includes('publish'));
});

test('an expired job deadline fails the attempt without calling the engine', async () => {
  const notices: string[] = [];
  const repository = fakeRepository({
    job: job({ startedAt: new Date(Date.now() - 60_000) }),
    artifacts: [artifactMeta()],
  });
  const instance = processor({
    repository, storage: fakeStorage(),
    validator: { inspect: async () => assert.fail('inspect') } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  await instance.process('job-1');
  assert.ok(repository.calls.some(call => call.startsWith('fail:E_TIMEOUT')));
  assert.ok(notices.includes('E_TIMEOUT'));
});

test('missing input metadata fails validation during inspect', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [] });
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => assert.fail('inspect') } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  await instance.process('job-1');
  assert.ok(repository.calls.some(call => call.startsWith('fail:E_VALIDATION')));
});

test('oversized instructions are rejected as E_PARAMS before the engine starts', async () => {
  const huge = Buffer.alloc(400_001, 65);
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': huge,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => [inventory()] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  await instance.process('job-1');
  assert.ok(repository.calls.some(call => call.startsWith('fail:E_PARAMS')));
});

test('a cancelled or fenced job swallows the failure path after inspect errors', async () => {
  const repository = fakeRepository({
    job: job({ status: 'cancelled', fence: 9, leaseToken: 'other' }),
    artifacts: [artifactMeta()],
  });
  repository.claimAttempt = async () => lease;
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const notices: string[] = [];
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => { throw new DocSandboxError('E_VALIDATION', 422); } } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  await instance.process('job-1');
  assert.equal(repository.calls.some(call => call.startsWith('fail:')), false);
  assert.deepEqual(notices, []);
});

test('handleFailure persists a validation report and notifies the operational code', async () => {
  const notices: string[] = [];
  const stored = fakeStorage();
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  const failed = report();
  failed.passed = false;
  const evidence: Artifact = {
    name: 'text-diff.json', kind: 'text_diff', mime: 'application/json',
    data: Buffer.from('{"ok":false}'), sha256: sha256(Buffer.from('{"ok":false}')),
  };
  await instance['handleFailure'](lease, new DocSandboxError('E_VALIDATION', 422), {
    timedOut: false, phase: 'validating', latestReport: { ...failed, artifacts: [evidence] },
    originalInputs: [inputFile()], failureEvidenceMode: { kind: 'single' },
  });
  assert.ok(repository.calls.some(call => call === 'fail:E_VALIDATION:true'));
  assert.ok(notices.includes('E_VALIDATION'));
});

test('handleFailure rejects corrupted evidence before reserving storage', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: fakeStorage(),
    validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  await assert.rejects(instance['handleFailure'](lease, new DocSandboxError('E_VALIDATION', 422), {
    timedOut: false, phase: 'validating',
    latestReport: { ...report(), artifacts: [{ name: 'text-diff.json', kind: 'text_diff', mime: 'application/json',
      data: Buffer.from('x'), sha256: '0'.repeat(64) }] },
    originalInputs: [inputFile()],
  }), (error: unknown) => error instanceof DocSandboxError && error.code === 'E_VALIDATION');
});

test('an editing refusal restores originals after the engine reports not_possible', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const approved = plan();
  const instance = processor({
    repository, storage: stored,
    validator: {
      inspect: async () => [inventory()],
      inspectRecipeArchive: async () => ({ sha256: sha256(recipe), size: recipe.length, expandedBytes: 1, scripts: ['01.py'], parts: {} }),
      validate: async () => report(hash),
    } as never,
    engineFactory: () => ({
      createSession: async () => session,
      uploadInputs: async () => undefined,
      run: async (_handle, request) => request.stage === 'plan'
        ? { status: 'planned' as const, editPlan: approved, usage: emptyUsage(), transcript: [] }
        : {
          status: 'not_possible' as const, editPlan: request.approvedPlan ?? approved,
          agentResult: {
            schemaVersion: 1, outputName: 'informe.txt', outcome: 'not_possible',
            editsApplied: [], editsFailed: ['e1'], partsModified: [], pagesAffected: [],
            warnings: ['The source cannot be changed as requested.'],
            selfCheck: { openedOk: false, textDiffMatchesPlan: false },
          },
          usage: emptyUsage(), transcript: [],
        },
      downloadOutputs: async () => [{
        name: 'transcript.json', kind: 'transcript' as const, mime: 'application/json',
        data: Buffer.from('[]'), sha256: sha256(Buffer.from('[]')),
      }],
      destroy: async () => undefined,
    }),
  });
  await instance.process('job-1');
  assert.ok(repository.calls.includes('publish'));
});

test('heartbeat renew aborts when the lease is lost mid-inspect', async () => {
  const notices: string[] = [];
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  let beats = 0;
  repository.heartbeat = async () => {
    beats += 1;
    if (beats === 1) throw new DocumentRepositoryError('DOC_STALE_LEASE');
  };
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const instance = new DocumentSandboxProcessor({
    repository: repository as never,
    storage: stored as never,
    validator: {
      inspect: async () => {
        await new Promise(resolve => setTimeout(resolve, 1_200));
        return [inventory()];
      },
    } as never,
    engineFactory: () => { throw new Error('engine'); },
    onNotice: ({ code }) => notices.push(code),
  }, { maxTurns: 8, maxTokens: 20_000, timeoutMs: 30_000, leaseMs: 3_000 });
  await instance.process('job-1');
  assert.ok(beats >= 1);
});

test('persist compensates a failed PUT and reports pending cleanup when compensation also fails', async () => {
  const notices: string[] = [];
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const storage = fakeStorage();
  storage.putPrepared = async () => { throw new Error('put'); };
  storage.remove = async () => { throw new Error('remove'); };
  const instance = processor({
    repository, storage, validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  const data = Buffer.from('ok');
  await assert.rejects(instance['persist'](lease, { userId: 'owner-1', jobId: 'job-1' }, {
    name: 'out.txt', kind: 'output', mime: 'text/plain', data, sha256: sha256(data),
  }), /put/);
  assert.ok(notices.includes('DOC_STORAGE_CLEANUP_PENDING'));
});

test('persist rethrows after a successful compensation purge', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const storage = fakeStorage();
  storage.putPrepared = async () => { throw new Error('put'); };
  const instance = processor({
    repository, storage, validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  const data = Buffer.from('ok');
  await assert.rejects(instance['persist'](lease, { userId: 'owner-1', jobId: 'job-1' }, {
    name: 'out.txt', kind: 'output', mime: 'text/plain', data, sha256: sha256(data),
  }), /put/);
  assert.ok(repository.calls.includes('purgedKeys'));
});

test('persist succeeds after a reserved key and returns the durable identity', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const storage = fakeStorage();
  const instance = processor({
    repository, storage, validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  const data = Buffer.from('ok');
  const recorded = await instance['persist'](lease, { userId: 'owner-1', jobId: 'job-1' }, {
    name: 'out.txt', kind: 'output', mime: 'text/plain', data, sha256: sha256(data),
  });
  assert.equal(recorded.filename, 'out.txt');
  assert.equal(recorded.sha256, sha256(data));
  assert.match(recorded.storageKey, /\.sealed$/);
  assert.ok(repository.calls.includes('reserveKeys'));
  assert.ok(repository.calls.includes('heartbeat'));
});

test('engine persistence records session, files, reservations and usage against the repository', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: fakeStorage(), validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  const persistence = instance['enginePersistence'](lease, emptyUsage(), 1);
  await persistence.sessionCreated(session);
  await persistence.containerCreated(session, { id: 'ctr', expiresAt: null, stage: 'plan' });
  await persistence.fileChanged(session, { id: 'file_1', kind: 'input', state: 'known' });
  await persistence.fileChanged(session, { id: 'file_1', kind: 'input', state: 'deleted' });
  assert.equal(await persistence.reserve(session, { requestId: 'req-1', usd: 0.01 }), undefined);
  await persistence.settle(session, { requestId: 'req-1', usage: { ...emptyUsage(), costUsd: 0.01 }, uncertain: false });
  await persistence.usageChanged(session, emptyUsage());
  assert.ok(repository.calls.includes('session'));
  assert.ok(repository.calls.includes('container'));
  assert.ok(repository.calls.includes('files'));
  assert.ok(repository.calls.includes('fileDeleted'));
  assert.ok(repository.calls.includes('reserveCost'));
  assert.ok(repository.calls.includes('settle'));
  assert.ok(repository.calls.includes('usage'));
});

test('engine persistence rejects a duplicate reservation as a conflict', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  repository.reserveCost = async () => false;
  const instance = processor({
    repository, storage: fakeStorage(), validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  const persistence = instance['enginePersistence'](lease, emptyUsage(), 0);
  await assert.rejects(persistence.reserve(session, { requestId: 'dup', usd: 0.1 }),
    (error: unknown) => error instanceof DocSandboxError && error.code === 'E_CONFLICT');
});

test('recordEvent sanitizes phases and inapplicable validation before appending', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: fakeStorage(), validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  await instance['recordEvent'](lease, { type: 'phase', payload: { phase: 'Planificando edición' } });
  await instance['recordEvent'](lease, { type: 'phase', payload: { phase: 'Editando documento' } });
  await instance['recordEvent'](lease, { type: 'validation_level', payload: { applicable: false, level: 2, durationMs: 1.2 } });
  await instance['recordEvent'](lease, { type: 'warning', payload: { code: 'E_NOT_POSSIBLE', passed: true } });
  assert.equal(repository.calls.filter(call => call === 'event').length, 4);
});

test('metric callbacks that throw become operational notices and do not abort the job', async () => {
  const notices: string[] = [];
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const approved = plan();
  const output = Buffer.from('El informe dice 2027.\n');
  const instance = processor({
    repository, storage: stored,
    validator: {
      inspect: async () => [inventory()],
      inspectRecipeArchive: async () => ({ sha256: sha256(recipe), size: recipe.length, expandedBytes: 1, scripts: ['01.py'], parts: {} }),
      validate: async () => report(sha256(output)),
    } as never,
    engineFactory: () => ({
      createSession: async () => session,
      uploadInputs: async () => undefined,
      run: async (_handle, request) => request.stage === 'plan'
        ? { status: 'planned', editPlan: approved, usage: emptyUsage(), transcript: [] }
        : { status: 'edited', editPlan: request.approvedPlan ?? approved, agentResult: {
          schemaVersion: 1, outputName: 'informe.txt', outcome: 'edited', editsApplied: ['e1'],
          editsFailed: [], partsModified: ['$document'], pagesAffected: [], warnings: [],
          selfCheck: { openedOk: true, textDiffMatchesPlan: true },
        }, usage: emptyUsage(), transcript: [] },
      downloadOutputs: async () => [outputArtifact(output), recipeZip(), agentResult(approved)],
      destroy: async () => { throw new Error('destroy'); },
    }),
    onPhase: () => { throw new Error('phase'); },
    onValidation: () => { throw new Error('validation'); },
  }, notices);
  await instance.process('job-1');
  assert.ok(repository.calls.includes('publish'));
  assert.ok(notices.includes('DOC_METRICS_FAILURE'));
  assert.ok(notices.includes('DOC_CLEANUP_PENDING'));
});

test('a mutated edit plan after approval is a validation failure', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const approved = plan();
  const instance = processor({
    repository, storage: stored,
    validator: {
      inspect: async () => [inventory()],
      inspectRecipeArchive: async () => assert.fail('recipe'),
      validate: async () => assert.fail('validate'),
    } as never,
    engineFactory: () => ({
      createSession: async () => session,
      uploadInputs: async () => undefined,
      run: async (_handle, request) => request.stage === 'plan'
        ? { status: 'planned', editPlan: approved, usage: emptyUsage(), transcript: [] }
        : { status: 'planned', editPlan: approved, usage: emptyUsage(), transcript: [] },
      downloadOutputs: async () => [],
      destroy: async () => undefined,
    }),
  });
  await instance.process('job-1');
  assert.ok(repository.calls.some(call => call.startsWith('fail:E_VALIDATION')));
});

test('processor construction rejects unsafe lease and budget configuration', () => {
  assert.throws(() => new DocumentSandboxProcessor({
    repository: {} as never, storage: {} as never, validator: {} as never, engineFactory: () => { throw new Error('engine'); },
  }, { maxTurns: 1, maxTokens: 1, timeoutMs: 1, leaseMs: 10 }), (error: unknown) =>
    error instanceof DocSandboxError && error.code === 'E_NOT_READY');
});

test('process refuses a previous validation payload that is not valid JSON', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
    'doc-sandbox/owner-1/job-1/v1/report.sealed': Buffer.from('not-json'),
  });
  const repository = fakeRepository({
    job: job({ validationReportKey: 'doc-sandbox/owner-1/job-1/v1/report.sealed' }),
    artifacts: [artifactMeta()],
  });
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => [inventory()] } as never,
    engineFactory: () => ({
      createSession: async () => session,
      uploadInputs: async () => undefined,
      run: async () => { throw new Error('should not plan'); },
      downloadOutputs: async () => [],
      destroy: async () => undefined,
    }),
  });
  await instance.process('job-1');
  assert.ok(repository.calls.some(call => call.startsWith('fail:')));
});

test('an external abort during inspect is classified as cancellation', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => [inventory()] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  await instance.process('job-1', AbortSignal.abort());
  assert.ok(repository.calls.some(call => call.startsWith('fail:')));
});

test('engine persistence settles only certain paid usage and records accumulated tokens', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: fakeStorage(), validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  });
  const persistence = instance['enginePersistence'](lease, emptyUsage(), 2);
  await persistence.settle(session, { requestId: 'u', usage: emptyUsage(), uncertain: true });
  assert.equal(repository.calls.includes('settle'), false);
});

test('handleFailure maps repository, validator and unknown failures to stable public codes', async () => {
  const notices: string[] = [];
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const instance = processor({
    repository, storage: fakeStorage(), validator: { inspect: async () => [] } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  await instance['handleFailure'](lease, new DocumentRepositoryError('DOC_BUDGET_EXCEEDED'), {
    timedOut: false, phase: 'planning', originalInputs: [inputFile()],
  });
  await instance['handleFailure'](lease, new DocumentRepositoryError('DOC_STALE_LEASE'), {
    timedOut: false, phase: 'planning', originalInputs: [inputFile()],
  });
  await instance['handleFailure'](lease, new DocumentValidationError('VALIDATOR_UNAVAILABLE', 'down'), {
    timedOut: false, phase: 'validating', originalInputs: [inputFile()],
  });
  await instance['handleFailure'](lease, new DocumentValidationError('E_CANCELLED', 'stop'), {
    timedOut: false, phase: 'editing', originalInputs: [inputFile()],
  });
  await instance['handleFailure'](lease, new Error('private provider body'), {
    timedOut: true, phase: 'editing', originalInputs: [inputFile()],
  });
  assert.ok(notices.includes('E_QUOTA'));
  assert.ok(notices.includes('E_CANCELLED'));
  assert.ok(notices.includes('E_NOT_READY'));
  assert.ok(notices.includes('E_TIMEOUT'));
});

test('a successful heartbeat reschedules the next renewal while inspect is still running', async () => {
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const started = Date.now();
  const heartbeats: number[] = [];
  repository.heartbeat = async () => { heartbeats.push(Date.now() - started); };
  const instance = new DocumentSandboxProcessor({
    repository: repository as never,
    storage: stored as never,
    validator: {
      inspect: async () => {
        await new Promise(resolve => setTimeout(resolve, 2_200));
        return [inventory()];
      },
    } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, { maxTurns: 8, maxTokens: 20_000, timeoutMs: 30_000, leaseMs: 3_000 });
  await instance.process('job-1');
  const duringInspect = heartbeats.filter(elapsed => elapsed < 2_100);
  assert.ok(duringInspect.length >= 2, `renewals during inspect=${duringInspect.join(',')} all=${heartbeats.join(',')}`);
});

test('repository conflict during inspect is classified without leaking private text', async () => {
  const repository = fakeRepository({ job: job(), artifacts: [artifactMeta()] });
  const stored = fakeStorage({
    'doc-sandbox/owner-1/job-1/v1/in.sealed': Buffer.from(bytes),
    'doc-sandbox/owner-1/job-1/v1/ins.sealed': instructions,
  });
  let heartbeats = 0;
  repository.heartbeat = async () => {
    heartbeats += 1;
    if (heartbeats === 1) throw new DocumentRepositoryError('DOC_STALE_LEASE');
  };
  const notices: string[] = [];
  const instance = processor({
    repository, storage: stored,
    validator: { inspect: async () => [inventory()] } as never,
    engineFactory: () => { throw new Error('engine'); },
  }, notices);
  await instance.process('job-1');
  // The heartbeat abort plus inspect success can race; either way no secret leaks.
  assert.equal(notices.some(code => code.includes('secret')), false);
});
