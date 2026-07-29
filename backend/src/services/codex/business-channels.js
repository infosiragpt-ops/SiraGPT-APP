'use strict';

const crypto = require('node:crypto');
const {
  derivePairingCode,
  isSenderAllowed,
  PENDING_MAX_PER_ACCOUNT,
  PENDING_TTL_MS: PAIRING_TTL_MS,
} = require('../business-channels/pairing');

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
  const secret = boundedText(
    env.CHANNEL_PAIRING_PEPPER || env.CHANNEL_CREDENTIALS_KEY || env.ENCRYPTION_KEY,
    256,
  );
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

async function reservePendingPairingSlot({ prisma, channelId, senderRef, now }) {
  const pairings = prisma?.businessChannelPairing;
  if (!pairings) throw new Error('business_channel_pairing_storage_unavailable');

  if (typeof pairings.updateMany === 'function') {
    await pairings.updateMany({
      where: {
        channelId,
        status: 'pending',
        expiresAt: { lte: now },
      },
      data: { status: 'expired' },
    });
  }

  if (
    typeof pairings.findMany !== 'function'
    || typeof pairings.updateMany !== 'function'
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
    await pairings.updateMany({
      where: { id: { in: evictedIds } },
      data: { status: 'expired' },
    });
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
  if (!channel || !sender || channel.status !== 'active') {
    return { allowed: false, reason: 'channel_unavailable' };
  }
  const policy = normalizeDmPolicy(channel.dmPolicy);
  const allowFrom = normalizeStringList(channel.allowFrom);
  if (isSenderAllowed({ senderId: sender, dmPolicy: policy, allowFrom })) {
    return { allowed: true, reason: policy === 'open' ? 'explicit_open_policy' : 'allowlist' };
  }
  if (policy !== 'pairing') {
    return {
      allowed: false,
      reason: policy === 'open' ? 'open_policy_requires_wildcard' : 'sender_not_allowed',
    };
  }

  const existing = typeof prisma?.businessChannelPairing?.findUnique === 'function'
    ? await prisma.businessChannelPairing.findUnique({
      where: { channelId_senderRef: { channelId: channel.id, senderRef: sender } },
    })
    : null;
  if (
    existing?.status === 'pending'
    && existing.expiresAt > now
  ) {
    const stableCode = createPairingCode({
      channelId: channel.id,
      senderRef: sender,
      expiresAt: existing.expiresAt,
      env,
    });
    if (pairingHashMatches({
      pairing: existing,
      channelId: channel.id,
      senderRef: sender,
      code: stableCode,
      env,
    })) {
      return {
        allowed: false,
        reason: 'pairing_required',
        pairingCode: stableCode,
        expiresAt: existing.expiresAt,
        created: false,
      };
    }
  }

  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const code = createPairingCode({
    channelId: channel.id,
    senderRef: sender,
    expiresAt,
    env,
  });
  await reservePendingPairingSlot({
    prisma,
    channelId: channel.id,
    senderRef: sender,
    now,
  });
  await prisma.businessChannelPairing.upsert({
    where: { channelId_senderRef: { channelId: channel.id, senderRef: sender } },
    create: {
      companyId: channel.companyId,
      channelId: channel.id,
      senderRef: sender,
      codeHash: pairingHash({ channelId: channel.id, senderRef: sender, code, env }),
      status: 'pending',
      expiresAt,
    },
    update: {
      codeHash: pairingHash({ channelId: channel.id, senderRef: sender, code, env }),
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
  };
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
  const channel = await prisma.businessChannel.findFirst({
    where: { id: channelId, companyId: company.id, userId: company.userId },
  });
  if (!channel) throw new Error('business_channel_not_found');
  const pairing = await prisma.businessChannelPairing.findUnique({
    where: { channelId_senderRef: { channelId, senderRef: sender } },
  });
  if (
    !pairing
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

  await prisma.businessChannelPairing.update({
    where: { id: pairing.id },
    data: { status: 'approved', approvedAt: now },
  });
  const allowFrom = normalizeStringList([...(channel.allowFrom || []), sender]);
  const updated = await prisma.businessChannel.update({
    where: { id: channel.id },
    data: { allowFrom },
  });
  return publicChannel(updated);
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
  const inboxMessage = await prisma.inboxMessage.upsert({
    where: { channelId_externalId: { channelId, externalId } },
    create: {
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
    update: {
      body,
      status: 'routed',
      departmentId: route.id,
      intent: route.intent,
      confidence: route.score,
    },
  });
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
  listBusinessChannels,
  normalizeDmPolicy,
  normalizeOutboundMode,
  openCredentials,
  publicChannel,
  recordInboundMessage,
  sanitizeChannelMetadata,
  sealCredentials,
  upsertBusinessChannel,
};
