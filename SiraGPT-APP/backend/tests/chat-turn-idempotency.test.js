'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  MESSAGE_IDEMPOTENCY_HASH_FIELD,
  buildActiveGenerateTurnKey,
  buildAiGenerateRequestFingerprint,
  buildMessageIdempotencyScopeKey,
  buildMessageRequestFingerprint,
  claimStreamController,
  createMessageIdempotencyCoordinator,
  findMessagesByTurnIdentity,
  findDuplicateMessageByIdempotency,
  findMatchingTurnPair,
  getStoredMessageRequestFingerprint,
  hasIdempotencyRequestConflict,
  metadataMatchesTurnIdentity,
  resolveTurnIdentity,
  waitForActiveTurn,
} = require('../src/services/chat-turn-idempotency');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chat turn idempotency', () => {
  it('reload follower reusing the durable stream id keeps Stop pointed at the original owner', () => {
    const registry = new Map();
    const ownerController = new AbortController();
    const followerController = new AbortController();
    const durableReloadStreamId = 'owner-stream-1';
    const key = `user-1:${durableReloadStreamId}`;

    assert.equal(claimStreamController(registry, key, ownerController), true);
    assert.equal(claimStreamController(registry, key, followerController), false);
    assert.equal(registry.get(key), ownerController);

    // This is the controller /stop-stream will abort.
    registry.get(key).abort();
    assert.equal(ownerController.signal.aborted, true);
    assert.equal(followerController.signal.aborted, false);

    // Retargeting is explicit and only valid after this request becomes the
    // replacement owner of the turn singleflight.
    assert.equal(
      claimStreamController(registry, key, followerController, { replaceOwner: true }),
      true,
    );
    assert.equal(registry.get(key), followerController);
  });

  it('reuses the same active key only for the same explicit turn identity', () => {
    const shared = { userId: 'user-1', chatId: 'chat-1' };
    const first = buildActiveGenerateTurnKey({
      ...shared,
      idempotencyKey: 'turn-1',
      prompt: 'continúa',
      model: 'model-a',
    });
    const retry = buildActiveGenerateTurnKey({
      ...shared,
      idempotencyKey: 'turn-1',
      streamId: 'replacement-stream',
      prompt: 'continúa',
      model: 'model-a',
    });
    const repeatedPrompt = buildActiveGenerateTurnKey({
      ...shared,
      idempotencyKey: 'turn-2',
      streamId: 'replacement-stream',
      prompt: 'continúa',
      model: 'model-b',
    });

    assert.equal(first, retry);
    assert.notEqual(first, repeatedPrompt);
  });

  it('falls back to stream identity and disables dedupe without an explicit signal', () => {
    const shared = { userId: 'user-1', chatId: 'chat-1' };
    assert.equal(
      buildActiveGenerateTurnKey({ ...shared, streamId: 'stream-1' }),
      buildActiveGenerateTurnKey({ ...shared, streamId: 'stream-1' }),
    );
    assert.equal(buildActiveGenerateTurnKey(shared), null);
    assert.equal(resolveTurnIdentity({}), null);
  });

  it('does not match equal prompt fingerprints when idempotency keys differ', () => {
    const stored = {
      idempotencyKey: 'turn-1',
      streamId: 'stream-1',
      turnFingerprint: 'same-content-fingerprint',
    };

    assert.equal(metadataMatchesTurnIdentity(stored, { idempotencyKey: 'turn-1' }), true);
    assert.equal(metadataMatchesTurnIdentity(stored, { idempotencyKey: 'turn-2' }), false);
  });

  it('supports legacy rows that stored the stream id as the idempotency key', () => {
    assert.equal(
      metadataMatchesTurnIdentity(
        { idempotencyKey: 'legacy-stream' },
        { streamId: 'legacy-stream' },
      ),
      true,
    );
  });

  it('deduplicates manual messages only when an explicit key is reused', () => {
    const recent = [
      { content: 'continúa', metadata: { idempotencyKey: 'turn-1' } },
    ];

    assert.equal(findDuplicateMessageByIdempotency(recent, 'turn-1'), recent[0]);
    assert.equal(findDuplicateMessageByIdempotency(recent, 'turn-2'), null);
    assert.equal(findDuplicateMessageByIdempotency(recent, null), null);
  });

  it('fingerprints the effective payload canonically and ignores reserved metadata', () => {
    const first = buildMessageRequestFingerprint({
      role: 'USER',
      content: 'continúa',
      tokens: 7,
      files: [{ id: 'file-1', name: 'brief.pdf' }],
      metadata: {
        z: 2,
        a: 1,
        idempotencyKey: 'turn-1',
        [MESSAGE_IDEMPOTENCY_HASH_FIELD]: 'client-spoof',
      },
    });
    const reordered = buildMessageRequestFingerprint({
      role: 'USER',
      content: 'continúa',
      tokens: 7n,
      files: [{ name: 'brief.pdf', id: 'file-1' }],
      metadata: { a: 1, z: 2, idempotencyKey: 'turn-2' },
    });

    assert.equal(first, reordered);
    assert.notEqual(first, buildMessageRequestFingerprint({
      role: 'USER',
      content: 'otra instrucción',
      tokens: 7,
      files: [{ id: 'file-1', name: 'brief.pdf' }],
      metadata: { a: 1, z: 2 },
    }));
  });

  it('serializes concurrent same-key writes so only one message is created', async () => {
    const coordinator = createMessageIdempotencyCoordinator();
    const scopeKey = buildMessageIdempotencyScopeKey({
      userId: 'user-1',
      chatId: 'chat-1',
      role: 'USER',
      idempotencyKey: 'turn-concurrent',
    });
    const fingerprint = buildMessageRequestFingerprint({
      role: 'USER',
      content: 'construye la app',
      metadata: {},
    });
    const rows = [];
    let creates = 0;

    const execute = () => coordinator.execute({
      scopeKey,
      requestFingerprint: fingerprint,
      findExisting: async () => rows[0] || null,
      create: async () => {
        creates += 1;
        await delay(20);
        const message = {
          id: `message-${creates}`,
          role: 'USER',
          content: 'construye la app',
          tokens: null,
          files: null,
          metadata: {
            idempotencyKey: 'turn-concurrent',
            [MESSAGE_IDEMPOTENCY_HASH_FIELD]: fingerprint,
          },
        };
        rows.unshift(message);
        return message;
      },
    });

    const results = await Promise.all([execute(), execute()]);

    assert.equal(creates, 1);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['created', 'duplicate']);
    assert.equal(results[0].message.id, results[1].message.id);
    assert.equal(coordinator.pendingCount(), 0);
  });

  it('scopes a message key across roles so role mutation reaches fingerprint conflict', () => {
    const shared = {
      userId: 'user-1',
      chatId: 'chat-1',
      idempotencyKey: 'turn-role-1',
    };
    assert.equal(
      buildMessageIdempotencyScopeKey({ ...shared, role: 'USER' }),
      buildMessageIdempotencyScopeKey({ ...shared, role: 'ASSISTANT' }),
    );
    assert.notEqual(
      buildMessageRequestFingerprint({ role: 'USER', content: 'same', metadata: {} }),
      buildMessageRequestFingerprint({ role: 'ASSISTANT', content: 'same', metadata: {} }),
    );
  });

  it('rejects a concurrent body mismatch and always releases the keyed slot', async () => {
    const coordinator = createMessageIdempotencyCoordinator();
    const scopeKey = buildMessageIdempotencyScopeKey({
      userId: 'user-1',
      chatId: 'chat-1',
      role: 'USER',
      idempotencyKey: 'turn-mismatch',
    });
    const rows = [];
    let creates = 0;

    const execute = (content) => {
      const requestFingerprint = buildMessageRequestFingerprint({
        role: 'USER',
        content,
        metadata: {},
      });
      return coordinator.execute({
        scopeKey,
        requestFingerprint,
        findExisting: async () => rows[0] || null,
        create: async () => {
          creates += 1;
          await delay(20);
          const message = {
            id: 'message-original',
            role: 'USER',
            content,
            tokens: null,
            files: null,
            metadata: {
              idempotencyKey: 'turn-mismatch',
              [MESSAGE_IDEMPOTENCY_HASH_FIELD]: requestFingerprint,
            },
          };
          rows.unshift(message);
          return message;
        },
      });
    };

    const [original, mismatch] = await Promise.all([
      execute('primera instrucción'),
      execute('payload mutado'),
    ]);

    assert.equal(original.outcome, 'created');
    assert.equal(mismatch.outcome, 'conflict');
    assert.equal(creates, 1);
    assert.equal(coordinator.pendingCount(), 0);

    rows.length = 0;
    await assert.rejects(
      coordinator.execute({
        scopeKey,
        requestFingerprint: 'failed-attempt',
        findExisting: async () => null,
        create: async () => { throw new Error('database unavailable'); },
      }),
      /database unavailable/,
    );
    const retry = await coordinator.execute({
      scopeKey,
      requestFingerprint: 'retry-after-failure',
      findExisting: async () => null,
      create: async () => ({ id: 'message-retry' }),
    });
    assert.equal(retry.outcome, 'created');
    assert.equal(coordinator.pendingCount(), 0);
  });

  it('does not serialize different keys or messages without a key', async () => {
    const coordinator = createMessageIdempotencyCoordinator();
    const scopes = [
      buildMessageIdempotencyScopeKey({
        userId: 'user-1', chatId: 'chat-1', role: 'USER', idempotencyKey: 'turn-a',
      }),
      buildMessageIdempotencyScopeKey({
        userId: 'user-1', chatId: 'chat-1', role: 'USER', idempotencyKey: 'turn-b',
      }),
      null,
      null,
    ];
    let active = 0;
    let maxActive = 0;
    let creates = 0;

    await Promise.all(scopes.map((scopeKey) => coordinator.execute({
      scopeKey,
      requestFingerprint: scopeKey ? 'same-fingerprint-is-safe-across-scopes' : null,
      findExisting: async () => null,
      create: async () => {
        creates += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
        return { id: `message-${creates}` };
      },
    })));

    assert.equal(creates, 4);
    assert.equal(maxActive, 4);
    assert.equal(coordinator.pendingCount(), 0);
  });

  it('derives a compatible fingerprint for pre-hash persisted messages', () => {
    const legacyMessage = {
      role: 'USER',
      content: 'continúa',
      tokens: 4n,
      files: null,
      metadata: { idempotencyKey: 'legacy-turn', source: 'chat' },
    };

    assert.equal(
      getStoredMessageRequestFingerprint(legacyMessage),
      buildMessageRequestFingerprint({
        role: 'USER',
        content: 'continúa',
        tokens: 4,
        files: null,
        metadata: { source: 'chat' },
      }),
    );
  });

  it('fingerprints requested AI intent while ignoring retry transport ids', () => {
    const baseBody = {
      chatId: 'chat-1',
      prompt: 'construye un agente',
      model: 'requested-model',
      provider: 'requested-provider',
      reasoningEffort: 'high',
      webSearchMode: 'auto',
      files: [{ id: 'file-1', mimeType: 'text/plain' }],
      idempotencyKey: 'turn-1',
      streamId: 'stream-1',
    };
    const fingerprint = buildAiGenerateRequestFingerprint({
      requestBody: baseBody,
    });
    const transportRetry = buildAiGenerateRequestFingerprint({
      requestBody: {
        streamId: 'replacement-stream',
        idempotencyKey: 'turn-1',
        files: [{ mimeType: 'text/plain', id: 'file-1' }],
        webSearchMode: 'auto',
        reasoningEffort: 'high',
        provider: 'requested-provider',
        model: 'requested-model',
        prompt: 'construye un agente',
        chatId: 'chat-1',
      },
    });

    assert.equal(fingerprint, transportRetry);
    // Quota routing operates on local route variables; it does not mutate the
    // requested body used here, so the same client intent keeps the same hash.
    assert.equal(fingerprint, buildAiGenerateRequestFingerprint({ requestBody: baseBody }));
    for (const mutation of [
      { ...baseBody, prompt: 'otra instrucción' },
      { ...baseBody, reasoningEffort: 'low' },
      { ...baseBody, files: [{ id: 'file-2' }] },
      { ...baseBody, model: 'another-requested-model' },
      { ...baseBody, provider: 'another-requested-provider' },
    ]) {
      assert.notEqual(fingerprint, buildAiGenerateRequestFingerprint({
        requestBody: mutation,
      }));
    }
  });

  it('keeps a timed-out active follower non-owner and preserves normal replay', async () => {
    let resolveOwner;
    let ownerInvocations = 0;
    const ownerPromise = new Promise((resolve) => { resolveOwner = resolve; });
    const activeTurn = {
      promise: (async () => {
        ownerInvocations += 1;
        return ownerPromise;
      })(),
    };
    let timeoutCallback;
    let clearedTimer = null;
    const waiting = waitForActiveTurn(activeTurn, {
      timeoutMs: 55_000,
      setTimeoutFn: (callback, timeoutMs) => {
        assert.equal(timeoutMs, 55_000);
        timeoutCallback = callback;
        return 'fake-timer';
      },
      clearTimeoutFn: (timer) => { clearedTimer = timer; },
    });

    timeoutCallback();
    const timedOut = await waiting;
    assert.equal(timedOut.outcome, 'in_progress');
    assert.equal(ownerInvocations, 1, 'the follower must not invoke owner work');
    assert.equal(clearedTimer, 'fake-timer');

    const pair = {
      userMessage: { id: 'user-message-1' },
      assistantMessage: { id: 'assistant-message-1', content: 'respuesta' },
    };
    const replay = await waitForActiveTurn({ promise: Promise.resolve(pair) });
    assert.equal(replay.outcome, 'replay');
    assert.equal(replay.turn, pair);
    resolveOwner(pair);
  });

  it('finds a recent keyed pair in a busy >80-message window and detects completed mismatch', () => {
    const oldMessages = Array.from({ length: 100 }, (_, index) => ({
      id: `old-${index}`,
      role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
      content: `old ${index}`,
      timestamp: new Date(1_700_000_000_000 + index),
      metadata: { idempotencyKey: `old-turn-${index}` },
    }));
    const requestFingerprint = 'a'.repeat(64);
    const recentPair = [
      {
        id: 'recent-user',
        role: 'USER',
        content: 'prompt reciente',
        timestamp: new Date(1_800_000_000_000),
        metadata: {
          idempotencyKey: 'recent-turn',
          [MESSAGE_IDEMPOTENCY_HASH_FIELD]: requestFingerprint,
        },
      },
      {
        id: 'recent-assistant',
        role: 'ASSISTANT',
        content: 'respuesta reciente',
        timestamp: new Date(1_800_000_000_001),
        metadata: JSON.stringify({
          idempotencyKey: 'recent-turn',
          [MESSAGE_IDEMPOTENCY_HASH_FIELD]: requestFingerprint,
        }),
      },
    ];
    const newestWindow = [...oldMessages, ...recentPair]
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 80);
    const parseMetadata = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
    const pair = findMatchingTurnPair(
      newestWindow,
      { idempotencyKey: 'recent-turn' },
      parseMetadata,
    );

    assert.equal(pair.userMessage.id, 'recent-user');
    assert.equal(pair.assistantMessage.id, 'recent-assistant');
    assert.equal(hasIdempotencyRequestConflict(
      [pair.userMessage, pair.assistantMessage],
      requestFingerprint,
      parseMetadata,
    ), false);
    assert.equal(hasIdempotencyRequestConflict(
      [pair.userMessage, pair.assistantMessage],
      'b'.repeat(64),
      parseMetadata,
    ), true);
  });

  it('finds an exact keyed turn older than 10 minutes in a chat with over 80 newer rows', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `noise-${index}`,
      role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
      timestamp: new Date(now - index * 1000),
      deletedAt: null,
      metadata: { idempotencyKey: `noise-turn-${index}` },
    }));
    rows.push(
      {
        id: 'old-user',
        role: 'USER',
        timestamp: new Date(now - 11 * 60 * 1000),
        deletedAt: null,
        metadata: { idempotencyKey: 'old-turn' },
      },
      {
        id: 'old-assistant',
        role: 'ASSISTANT',
        content: 'already completed',
        timestamp: new Date(now - (11 * 60 * 1000) + 1),
        deletedAt: null,
        metadata: { idempotencyKey: 'old-turn' },
      },
    );
    const queries = [];
    const matching = await findMessagesByTurnIdentity({
      chatId: 'chat-1',
      identityInput: { idempotencyKey: 'old-turn' },
      roles: ['USER', 'ASSISTANT'],
      parseMetadata: (value) => value,
      findMany: async (args) => {
        queries.push(args);
        return args.where.OR
          ? rows.filter((row) => row.metadata?.idempotencyKey === 'old-turn')
          : rows;
      },
    });

    assert.deepEqual(matching.map((message) => message.id), ['old-user', 'old-assistant']);
    assert.equal(queries.length, 1, 'object metadata should use the exact DB query without legacy scan');
    assert.equal(Object.hasOwn(queries[0], 'take'), false);
    assert.equal(Object.hasOwn(queries[0].where, 'timestamp'), false);
  });

  it('falls back without a time/window cap for legacy string metadata', async () => {
    const legacy = {
      id: 'legacy-assistant',
      role: 'ASSISTANT',
      timestamp: new Date(0),
      metadata: JSON.stringify({ idempotencyKey: 'legacy-old-turn' }),
    };
    const queries = [];
    const matching = await findMessagesByTurnIdentity({
      chatId: 'chat-1',
      identityInput: { idempotencyKey: 'legacy-old-turn' },
      roles: ['USER', 'ASSISTANT'],
      parseMetadata: (value) => typeof value === 'string' ? JSON.parse(value) : value,
      findMany: async (args) => {
        queries.push(args);
        return args.where.OR ? [] : [legacy];
      },
    });

    assert.deepEqual(matching, [legacy]);
    assert.equal(queries.length, 2);
    assert.equal(Object.hasOwn(queries[1], 'take'), false);
    assert.equal(Object.hasOwn(queries[1].where, 'timestamp'), false);
  });

  it('combines an exact USER row with its legacy string ASSISTANT row', async () => {
    const user = {
      id: 'mixed-user',
      role: 'USER',
      timestamp: new Date(100),
      metadata: { idempotencyKey: 'mixed-turn' },
    };
    const assistant = {
      id: 'mixed-assistant',
      role: 'ASSISTANT',
      content: 'already completed',
      timestamp: new Date(101),
      metadata: JSON.stringify({ idempotencyKey: 'mixed-turn' }),
    };
    const queries = [];
    const parseMetadata = (value) => typeof value === 'string' ? JSON.parse(value) : value;
    const matching = await findMessagesByTurnIdentity({
      chatId: 'chat-1',
      identityInput: { idempotencyKey: 'mixed-turn' },
      roles: ['USER', 'ASSISTANT'],
      parseMetadata,
      findMany: async (args) => {
        queries.push(args);
        return args.where.OR ? [user] : [user, assistant];
      },
    });
    const pair = findMatchingTurnPair(
      matching,
      { idempotencyKey: 'mixed-turn' },
      parseMetadata,
    );

    assert.equal(queries.length, 2, 'a partial exact result must trigger the legacy scan');
    assert.deepEqual(matching.map((message) => message.id), ['mixed-user', 'mixed-assistant']);
    assert.equal(pair.userMessage.id, 'mixed-user');
    assert.equal(pair.assistantMessage.id, 'mixed-assistant');
  });

  it('makes an intent-triage retry with the same key replay one persisted pair', () => {
    const aiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
    const triageStart = aiSource.indexOf('// ─── Intent Triage short-circuit');
    const triageEnd = aiSource.indexOf('// ─── Artifact branch', triageStart);
    const triageSource = aiSource.slice(triageStart, triageEnd);

    assert.ok(triageStart >= 0 && triageEnd > triageStart, 'intent-triage branch must exist');
    assert.match(
      triageSource,
      /persistUserMessageOnce\([\s\S]*?triageTurnMetadata,[\s\S]*?\{ idempotencyKey, streamId \},[\s\S]*?\)/,
    );
    assert.match(
      triageSource,
      /role:\s*'ASSISTANT'[\s\S]*?metadata:\s*triageTurnMetadata/,
    );
    assert.match(
      triageSource,
      /_activeGenerateTurn\.resolve\(\{[\s\S]*?userMessage:\s*triageUserMessage,[\s\S]*?assistantMessage:\s*triageAssistantMessage/,
    );

    const triagePair = [
      { role: 'USER', metadata: { idempotencyKey: 'triage-turn-1', origin: 'intent_triage' } },
      { role: 'ASSISTANT', metadata: JSON.stringify({ idempotencyKey: 'triage-turn-1', origin: 'intent_triage' }) },
    ];
    const replayPair = triagePair.filter((message) => metadataMatchesTurnIdentity(
      typeof message.metadata === 'string' ? JSON.parse(message.metadata) : message.metadata,
      { idempotencyKey: 'triage-turn-1' },
    ));
    assert.deepEqual(replayPair.map((message) => message.role), ['USER', 'ASSISTANT']);
  });

  it('wires active and completed AI mismatch checks without follower fallthrough', () => {
    const aiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
    const activeStart = aiSource.indexOf('const activeGenerateTurnKey = buildActiveGenerateTurnKey');
    const activeEnd = aiSource.indexOf('// ─── Prompt-injection preflight', activeStart);
    const activeSource = aiSource.slice(activeStart, activeEnd);
    const lookupStart = aiSource.indexOf('async function findExistingGenerateTurn');
    const lookupEnd = aiSource.indexOf('// Título estilo Claude', lookupStart);
    const lookupSource = aiSource.slice(lookupStart, lookupEnd);

    assert.ok(activeStart >= 0 && activeEnd > activeStart);
    assert.match(activeSource, /activeTurn\.requestFingerprint !== generateIdempotencyRequestHash/);
    assert.match(activeSource, /const activeWait = await waitForActiveTurn\(activeTurn\)/);
    assert.match(
      activeSource,
      /return respondGenerateTurnError\(res, \{[\s\S]*?code: 'turn_in_progress'/,
    );
    assert.match(
      activeSource,
      /createActiveGenerateTurn\([\s\S]*?activeGenerateTurnKey,[\s\S]*?generateIdempotencyRequestHash/,
    );
    assert.match(
      activeSource,
      /findExistingGenerateTurn\(\{[\s\S]*?requestFingerprint: generateIdempotencyRequestHash/,
    );
    assert.doesNotMatch(activeSource, /canPersist && !regenerate && activeGenerateTurnKey/);
    assert.doesNotMatch(activeSource, /&& !regenerate[\s\S]{0,120}resolveTurnIdentity/);
    assert.match(activeSource, /allowAssistantOnly: regenerate/);
    assert.match(activeSource, /claimStreamController\([\s\S]*?\{ replaceOwner: true \}/);
    assert.match(
      activeSource,
      /duplicateTurn\?\.idempotencyConflict[\s\S]*?IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
    );
    assert.match(lookupSource, /findMessagesByTurnIdentity\(\{[\s\S]*?roles: \['USER', 'ASSISTANT'\]/);
    assert.doesNotMatch(lookupSource, /timestamp:\s*\{\s*gte:|take:\s*80/);
  });

  it('wires both chat routes to explicit identities instead of content replay', () => {
    const aiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
    const chatsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');

    assert.match(aiSource, /buildActiveGenerateTurnKey\(\{[\s\S]*?idempotencyKey,[\s\S]*?streamId,/);
    assert.doesNotMatch(aiSource, /findRecentCompletedDuplicateTurn/);
    assert.match(chatsSource, /messageIdempotencyCoordinator\.execute\(\{/);
    assert.match(chatsSource, /metadata:\s*\{\s*path:\s*\['idempotencyKey'\],\s*equals:\s*explicitIdempotencyKey\s*\}/);
    assert.match(chatsSource, /status\(409\)[\s\S]*?IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/);
    assert.doesNotMatch(chatsSource, /existing\.content\s*!==\s*content/);
  });
});
