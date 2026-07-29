'use strict';

const crypto = require('node:crypto');
const {
  derivePairingCode,
  isSenderAllowed,
  PENDING_MAX_PER_ACCOUNT,
  PENDING_TTL_MS: PAIRING_TTL_MS,
} = require('../business-channels/pairing');
const { runWithLock } = require('../agents/mutex');

const CHANNEL_KINDS = Object.freeze([
  'telegram',
  'email',
  'whatsapp',
  'slack',
  'discord',
  'instagram',
  'facebook',
]);
const DM_POLICIES = Object.freeze(['pairing', 'allowlist', 'open', 'closed']);
const OUTBOUND_MODES = Object.freeze(['review', 'auto', 'off']);
const PAIRING_TRANSACTION_MAX_ATTEMPTS = 4;
const SENSITIVE_METADATA_KEY = /(?:authorization|cookie|credentials?|password|passwd|private[_-]?key|secret|token|api[_-]?key)/i;
const UNSAFE_METADATA_KEY = /^(?:__proto__|constructor|prototype)$/i;

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeStringList(value, maxItems = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => boundedText(item, 240)).filter(Boolean))].slice(0, maxItems);
}

function normalizeDmPolicy(value) {
  return DM_POLICIES.includes(value) ? value : 'pairing';
}

function normalizeOutboundMode(value) {
  return OUTBOUND_MODES.includes(value) ? value : 'review';
}

function sanitizeChannelMetadata(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizeChannelMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_METADATA_KEY.test(key) || UNSAFE_METADATA_KEY.test(key)) continue;
    const sanitized = sanitizeChannelMetadata(item, depth + 1);
    if (sanitized !== undefined) output[key.slice(0, 120)] = sanitized;
  }
  return output;
}

function encryptionKey(env = process.env) {
  const raw = boundedText(env.CHANNEL_CREDENTIALS_KEY || env.ENCRYPTION_KEY, 128);
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    const error = new Error('channel_credentials_key_unavailable');
    error.status = 503;
    throw error;
  }
  return Buffer.from(raw, 'hex');
}

function sealCredentials(value, env = process.env) {
  if (value == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function openCredentials(value, env = process.env) {
  if (!value) return null;
  const [version, ivHex, tagHex, encryptedHex] = String(value).split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !encryptedHex) throw new Error('invalid_channel_credentials');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8'));
}

function publicChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    label: row.label || null,
    connectorAccountId: row.connectorAccountId || null,
    dmPolicy: normalizeDmPolicy(row.dmPolicy),
    allowFrom: normalizeStringList(row.allowFrom),
    outboundMode: normalizeOutboundMode(row.outboundMode),
    status: row.status,
    credentialsConfigured: Boolean(row.credentialsEncrypted || row.connectorAccountId),
    metadata: sanitizeChannelMetadata(row.metadata) || null,
    lastInboundAt: row.lastInboundAt || null,
    lastOutboundAt: row.lastOutboundAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listBusinessChannels({ prisma, companyId, userId }) {
  if (!prisma?.businessChannel?.findMany) return [];
  const rows = await prisma.businessChannel.findMany({
    where: { companyId, userId },
    orderBy: [{ createdAt: 'asc' }, { kind: 'asc' }],
  });
  return rows.map(publicChannel);
}

async function upsertBusinessChannel({
  prisma,
  company,
  channelId = null,
  input,
  env = process.env,
}) {
  if (!company?.id || !company.userId) throw new Error('company_required');
  if (!prisma?.businessChannel?.create || !prisma?.businessChannel?.update) {
    throw new Error('business_channel_storage_unavailable');
  }
  const kind = boundedText(input?.kind, 40).toLowerCase();
  if (!CHANNEL_KINDS.includes(kind)) throw new Error('invalid_channel_kind');
  const connectorAccountId = boundedText(input?.connectorAccountId, 100) || null;
  if (connectorAccountId) {
    const connector = await prisma.connectorAccount.findFirst({
      where: { id: connectorAccountId, userId: company.userId, status: 'connected' },
    });
    if (!connector) throw new Error('connector_not_available');
  }
  const credentialsProvided = Object.prototype.hasOwnProperty.call(input || {}, 'credentials');
  const data = {
    companyId: company.id,
    userId: company.userId,
    connectorAccountId,
    kind,
    label: boundedText(input?.label, 120) || null,
    dmPolicy: normalizeDmPolicy(input?.dmPolicy),
    allowFrom: normalizeStringList(input?.allowFrom),
    outboundMode: normalizeOutboundMode(input?.outboundMode),
    status: ['active', 'paused', 'broken'].includes(input?.status) ? input.status : 'active',
    metadata: input?.metadata && typeof input.metadata === 'object'
      ? sanitizeChannelMetadata(input.metadata)
      : undefined,
    ...(credentialsProvided ? { credentialsEncrypted: sealCredentials(input.credentials, env) } : {}),
  };
  if (!channelId) return publicChannel(await prisma.businessChannel.create({ data }));
  const current = await prisma.businessChannel.findFirst({
    where: { id: channelId, companyId: company.id, userId: company.userId },
  });
  if (!current) throw new Error('business_channel_not_found');
  return publicChannel(await prisma.businessChannel.update({
    where: { id: current.id },
    data,
  }));
}

function pairingSecret(env = process.env) {
  const secret = boundedText(env.CHANNEL_PAIRING_PEPPER, 256);
  if (secret) return secret;
  if (env.NODE_ENV === 'production') throw new Error('channel_pairing_secret_unavailable');
  return 'sira-channel-pairing-test-secret';
}

function pairingHash({ channelId, senderRef, code, env = process.env }) {
  return crypto
    .createHmac('sha256', pairingSecret(env))
    .update(`${channelId}\0${senderRef}\0${String(code).toUpperCase()}`)
    .digest('hex');
}

function pairingCodeScope({ channelId, senderRef, expiresAt }) {
  return `${channelId}\0${senderRef}\0${new Date(expiresAt).getTime()}`;
}

function createPairingCode({ channelId, senderRef, expiresAt, env = process.env }) {
  return derivePairingCode({
    secret: pairingSecret(env),
    scope: pairingCodeScope({ channelId, senderRef, expiresAt }),
  });
}

function pairingHashMatches({ pairing, channelId, senderRef, code, env = process.env }) {
  const expected = pairingHash({ channelId, senderRef, code, env });
  const actual = String(pairing?.codeHash || '');
  return actual.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function isRetryablePairingTransactionError(error) {
  const diagnostic = [
    error?.code,
    error?.meta?.code,
    error?.meta?.message,
    error?.message,
  ].filter(Boolean).join(' ');
  return /P2034|40001|40P01|write conflict|deadlock/iu.test(diagnostic);
}

function pairingRetryDelay(attempt) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(10 * (2 ** (attempt - 1)), 80));
  });
}

async function withChannelPairingLock({ prisma, channelId, operation }) {
  if (
    !prisma
    || typeof prisma.$transaction !== 'function'
    || typeof operation !== 'function'
  ) {
    throw new Error('business_channel_pairing_storage_unavailable');
  }
  return runWithLock(`business-channel-pairing:${channelId}`, async () => {
    for (let attempt = 1; attempt <= PAIRING_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          if (typeof tx.$queryRaw !== 'function') {
            throw new Error('business_channel_pairing_atomic_storage_required');
          }
          const lockKey = `business-channel-pairing:${channelId}`;
          await tx.$queryRaw`
            WITH pairing_lock AS (
              SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
            )
            SELECT 1::int AS locked FROM pairing_lock
          `;
          return operation(tx);
        }, {
          isolationLevel: 'Serializable',
          maxWait: 5_000,
          timeout: 10_000,
        });
      } catch (error) {
        if (
          attempt === PAIRING_TRANSACTION_MAX_ATTEMPTS
          || !isRetryablePairingTransactionError(error)
        ) {
          throw error;
        }
        await pairingRetryDelay(attempt);
      }
    }
    throw new Error('business_channel_pairing_transaction_exhausted');
  });
}

async function reservePendingPairingSlot({ prisma, channelId, senderRef, now }) {
  const pairings = prisma?.businessChannelPairing;
  if (!pairings) throw new Error('business_channel_pairing_storage_unavailable');

  if (typeof pairings.deleteMany === 'function') {
    await pairings.deleteMany({
      where: {
        channelId,
        status: 'pending',
        expiresAt: { lte: now },
      },
    });
  } else if (typeof pairings.updateMany === 'function') {
    await pairings.updateMany({
      where: { channelId, status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
  }

  if (
    typeof pairings.findMany !== 'function'
    || (
      typeof pairings.deleteMany !== 'function'
      && typeof pairings.updateMany !== 'function'
    )
  ) {
    return;
  }

  const live = await pairings.findMany({
    where: {
      channelId,
      status: 'pending',
      expiresAt: { gt: now },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, senderRef: true },
  });
  const otherSenders = live.filter((pairing) => pairing.senderRef !== senderRef);
  const overflow = Math.max(
    0,
    otherSenders.length - PENDING_MAX_PER_ACCOUNT + 1,
  );
  const evictedIds = otherSenders.slice(0, overflow).map((pairing) => pairing.id);
  if (evictedIds.length > 0) {
    if (typeof pairings.deleteMany === 'function') {
      await pairings.deleteMany({ where: { id: { in: evictedIds } } });
    } else {
      await pairings.updateMany({
        where: { id: { in: evictedIds } },
        data: { status: 'expired' },
      });
    }
  }
}

async function authorizeSender({
  prisma,
  channel,
  senderRef,
  now = new Date(),
  env = process.env,
}) {
  const sender = boundedText(senderRef, 240);
  const channelId = boundedText(channel?.id, 100);
  const companyId = boundedText(channel?.companyId, 100);
  const userId = boundedText(channel?.userId, 100);
  if (!sender || !channelId || !companyId || !userId) {
    return { allowed: false, reason: 'channel_unavailable' };
  }
  return withChannelPairingLock({
    prisma,
    channelId,
    operation: async (db) => {
      if (typeof db?.businessChannel?.findFirst !== 'function') {
        throw new Error('business_channel_storage_unavailable');
      }
      const activeChannel = await db.businessChannel.findFirst({
        where: { id: channelId, companyId, userId },
      });
      if (!activeChannel || activeChannel.status !== 'active') {
        return { allowed: false, reason: 'channel_unavailable' };
      }
      const policy = normalizeDmPolicy(activeChannel.dmPolicy);
      const allowFrom = normalizeStringList(activeChannel.allowFrom);
      if (isSenderAllowed({ senderId: sender, dmPolicy: policy, allowFrom })) {
        return {
          allowed: true,
          reason: policy === 'open' ? 'explicit_open_policy' : 'allowlist',
        };
      }
      if (policy === 'closed') {
        return { allowed: false, reason: 'sender_not_allowed' };
      }

      const existing = typeof db?.businessChannelPairing?.findUnique === 'function'
        ? await db.businessChannelPairing.findUnique({
          where: {
            channelId_senderRef: {
              channelId: activeChannel.id,
              senderRef: sender,
            },
          },
        })
        : null;
      if (existing && existing.companyId !== activeChannel.companyId) {
        throw new Error('business_channel_pairing_tenant_mismatch');
      }
      if (existing?.status === 'approved') {
        return { allowed: true, reason: 'approved_pairing' };
      }
      if (policy !== 'pairing') {
        return {
          allowed: false,
          reason: policy === 'open'
            ? 'open_policy_requires_wildcard'
            : 'sender_not_allowed',
        };
      }

      const existingExpiresAt = existing?.expiresAt
        ? new Date(existing.expiresAt)
        : null;
      if (
        existing?.status === 'pending'
        && existingExpiresAt
        && existingExpiresAt > now
      ) {
        const stableCode = createPairingCode({
          channelId: activeChannel.id,
          senderRef: sender,
          expiresAt: existingExpiresAt,
          env,
        });
        if (pairingHashMatches({
          pairing: existing,
          channelId: activeChannel.id,
          senderRef: sender,
          code: stableCode,
          env,
        })) {
          return {
            allowed: false,
            reason: 'pairing_required',
            pairingCode: stableCode,
            expiresAt: existingExpiresAt,
            created: false,
          };
        }
      }

      const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
      const code = createPairingCode({
        channelId: activeChannel.id,
        senderRef: sender,
        expiresAt,
        env,
      });
      await reservePendingPairingSlot({
        prisma: db,
        channelId: activeChannel.id,
        senderRef: sender,
        now,
      });
      await db.businessChannelPairing.upsert({
        where: {
          channelId_senderRef: {
            channelId: activeChannel.id,
            senderRef: sender,
          },
        },
        create: {
          companyId: activeChannel.companyId,
          channelId: activeChannel.id,
          senderRef: sender,
          codeHash: pairingHash({
            channelId: activeChannel.id,
            senderRef: sender,
            code,
            env,
          }),
          status: 'pending',
          expiresAt,
        },
        update: {
          companyId: activeChannel.companyId,
          codeHash: pairingHash({
            channelId: activeChannel.id,
            senderRef: sender,
            code,
            env,
          }),
          status: 'pending',
          expiresAt,
          approvedAt: null,
        },
      });
      return {
        allowed: false,
        reason: 'pairing_required',
        pairingCode: code,
        expiresAt,
        created: true,
        ...(existing?.status === 'pending'
          ? { rotated: true, rotationReason: 'legacy_or_secret_changed' }
          : {}),
      };
    },
  });
}

function createBusinessChannelAuthorizer({
  prisma,
  companyId,
  userId,
  channelId,
  env = process.env,
}) {
  const scope = {
    companyId: boundedText(companyId, 100),
    userId: boundedText(userId, 100),
    channelId: boundedText(channelId, 100),
  };
  if (!scope.companyId || !scope.userId || !scope.channelId) {
    throw new Error('business_channel_authorizer_scope_required');
  }
  const accountId = `${scope.companyId}:${scope.userId}:${scope.channelId}`;
  return Object.freeze({
    accountId,
    authorizeInbound: async ({ accountId: inboundAccountId, senderId }) => {
      if (inboundAccountId !== accountId) {
        return { allowed: false, reason: 'business_channel_scope_mismatch' };
      }
      return authorizeSender({
        prisma,
        channel: {
          id: scope.channelId,
          companyId: scope.companyId,
          userId: scope.userId,
        },
        senderRef: senderId,
        env,
      });
    },
  });
}

async function approvePairing({
  prisma,
  company,
  channelId,
  senderRef,
  code,
  now = new Date(),
  env = process.env,
}) {
  const sender = boundedText(senderRef, 240);
  if (!sender) throw new Error('invalid_pairing_sender');
  return withChannelPairingLock({
    prisma,
    channelId,
    operation: async (db) => {
      const channel = await db.businessChannel.findFirst({
        where: { id: channelId, companyId: company.id, userId: company.userId },
      });
      if (!channel) throw new Error('business_channel_not_found');
      if (isSenderAllowed({
        senderId: sender,
        dmPolicy: normalizeDmPolicy(channel.dmPolicy),
        allowFrom: normalizeStringList(channel.allowFrom),
      })) {
        throw new Error('sender_statically_allowlisted');
      }
      const pairing = await db.businessChannelPairing.findUnique({
        where: { channelId_senderRef: { channelId, senderRef: sender } },
      });
      if (
        pairing?.companyId !== company.id
        || pairing.status !== 'pending'
        || pairing.expiresAt <= now
        || !pairingHashMatches({
          pairing,
          channelId,
          senderRef: sender,
          code,
          env,
        })
      ) throw new Error('invalid_or_expired_pairing_code');

      await db.businessChannelPairing.update({
        where: { id: pairing.id },
        data: { status: 'approved', approvedAt: now },
      });
      return publicChannel(channel);
    },
  });
}

async function revokePairing({
  prisma,
  company,
  channelId,
  senderRef,
  now = new Date(),
}) {
  const sender = boundedText(senderRef, 240);
  if (!sender) throw new Error('invalid_pairing_sender');
  return withChannelPairingLock({
    prisma,
    channelId,
    operation: async (db) => {
      const channel = await db.businessChannel.findFirst({
        where: { id: channelId, companyId: company.id, userId: company.userId },
      });
      if (!channel) throw new Error('business_channel_not_found');
      if (isSenderAllowed({
        senderId: sender,
        dmPolicy: normalizeDmPolicy(channel.dmPolicy),
        allowFrom: normalizeStringList(channel.allowFrom),
      })) {
        throw new Error('sender_statically_allowlisted');
      }
      const pairing = await db.businessChannelPairing.findUnique({
        where: { channelId_senderRef: { channelId, senderRef: sender } },
      });
      if (pairing?.companyId === company.id) {
        await db.businessChannelPairing.update({
          where: { id: pairing.id },
          data: { status: 'revoked', approvedAt: null, expiresAt: now },
        });
      }
      return publicChannel(channel);
    },
  });
}

function classifyDepartment(body) {
  const text = boundedText(body, 10_000).toLocaleLowerCase('es');
  const rules = [
    { id: 'trust', intent: 'security', score: 0.92, pattern: /seguridad|privacidad|fraude|phishing|permiso|cumplimiento/ },
    { id: 'customer-success', intent: 'support', score: 0.9, pattern: /soporte|ayuda|error|problema|reclamo|devoluci[oó]n|factura/ },
    { id: 'sales', intent: 'sales', score: 0.88, pattern: /precio|cotizaci[oó]n|comprar|demo|contrato|presupuesto|venta/ },
    { id: 'marketing', intent: 'marketing', score: 0.86, pattern: /campa[nñ]a|marketing|contenido|publicaci[oó]n|seo|redes/ },
    { id: 'product-engineering', intent: 'engineering', score: 0.84, pattern: /api|c[oó]digo|bug|integraci[oó]n|software|aplicaci[oó]n/ },
  ];
  const match = rules.find((rule) => rule.pattern.test(text));
  return match || { id: 'ceo-office', intent: 'general', score: 0.55 };
}

async function recordInboundMessage({
  prisma,
  company,
  channelId,
  message,
  runService = null,
  queue = null,
  env = process.env,
  now = new Date(),
}) {
  const channel = await prisma.businessChannel.findFirst({
    where: { id: channelId, companyId: company.id, userId: company.userId },
    include: { company: { include: { project: { include: { codexLink: true } } } } },
  });
  if (!channel) throw new Error('business_channel_not_found');
  const authorization = await authorizeSender({
    prisma,
    channel,
    senderRef: message?.from,
    now,
    env,
  });
  if (!authorization.allowed) return { authorization, inboxMessage: null, run: null };

  const body = boundedText(message?.body, 50_000);
  const externalId = boundedText(message?.externalId, 240);
  const sender = boundedText(message?.from, 240);
  if (!body || !externalId || !sender) throw new Error('invalid_inbox_message');
  const route = classifyDepartment(body);
  let inboxMessage;
  try {
    inboxMessage = await prisma.inboxMessage.create({
      data: {
        companyId: company.id,
        channelId,
        externalId,
        threadId: boundedText(message?.threadId, 240) || null,
        from: sender,
        body,
        direction: 'inbound',
        status: 'routed',
        departmentId: route.id,
        intent: route.intent,
        confidence: route.score,
        metadata: message?.metadata && typeof message.metadata === 'object'
          ? sanitizeChannelMetadata(message.metadata)
          : undefined,
        receivedAt: message?.receivedAt ? new Date(message.receivedAt) : now,
      },
    });
  } catch (error) {
    // The database unique key on {channelId, externalId} is the cross-process
    // idempotency gate. Only the request that creates the row may create a run.
    if (error?.code !== 'P2002') throw error;
    return {
      authorization,
      inboxMessage: null,
      run: null,
      duplicate: true,
    };
  }
  await prisma.businessChannel.update({
    where: { id: channel.id },
    data: { lastInboundAt: now },
  });

  let run = null;
  const codexProjectId = channel.company?.project?.codexLink?.codexProjectId;
  if (runService?.createRun && codexProjectId) {
    const prompt = [
      `[CANAL · ${route.id}]`,
      `Empresa: ${company.name}`,
      `Canal: ${channel.kind}`,
      `Remitente: ${sender}`,
      `Mensaje: ${body}`,
      'Clasifica la necesidad y prepara una respuesta precisa. No envíes nada: la salida queda en revisión humana.',
    ].join('\n');
    run = await runService.createRun({
      userId: company.userId,
      projectId: codexProjectId,
      mode: 'plan',
      prompt,
      autoExecute: false,
      db: prisma,
      ...(queue ? { queue } : {}),
      env,
    }).catch(() => null);
    if (run) {
      await prisma.inboxMessage.update({
        where: { id: inboxMessage.id },
        data: {
          status: 'waiting_approval',
          metadata: {
            ...(sanitizeChannelMetadata(inboxMessage.metadata) || {}),
            runId: run.id,
            outboundMode: normalizeOutboundMode(channel.outboundMode),
          },
        },
      });
    }
  }
  return { authorization, inboxMessage, run };
}

async function auditChannelPolicies({ prisma, companyId, userId }) {
  const rows = await prisma.businessChannel.findMany({
    where: { companyId, userId },
    include: { connectorAccount: true },
  });
  const findings = [];
  for (const channel of rows) {
    if (channel.dmPolicy === 'open') {
      findings.push({ severity: 'high', channelId: channel.id, code: 'open_dm_policy' });
    }
    if (channel.dmPolicy === 'allowlist' && !(channel.allowFrom || []).length) {
      findings.push({ severity: 'high', channelId: channel.id, code: 'empty_allowlist' });
    }
    if (!channel.credentialsEncrypted && !channel.connectorAccountId) {
      findings.push({ severity: 'medium', channelId: channel.id, code: 'credentials_missing' });
    }
    if (channel.connectorAccountId && channel.connectorAccount?.status !== 'connected') {
      findings.push({ severity: 'high', channelId: channel.id, code: 'connector_unhealthy' });
    }
    if (channel.outboundMode === 'auto') {
      findings.push({ severity: 'info', channelId: channel.id, code: 'automatic_outbound_enabled' });
    }
  }
  return {
    ok: !findings.some((finding) => finding.severity === 'high'),
    channels: rows.length,
    findings,
  };
}

module.exports = {
  CHANNEL_KINDS,
  DM_POLICIES,
  OUTBOUND_MODES,
  PENDING_MAX_PER_ACCOUNT,
  PAIRING_TTL_MS,
  approvePairing,
  auditChannelPolicies,
  authorizeSender,
  classifyDepartment,
  createBusinessChannelAuthorizer,
  listBusinessChannels,
  normalizeDmPolicy,
  normalizeOutboundMode,
  openCredentials,
  publicChannel,
  recordInboundMessage,
  revokePairing,
  sanitizeChannelMetadata,
  sealCredentials,
  upsertBusinessChannel,
};
