'use strict';

const { createHash } = require('node:crypto');
const externalActions = require('./external-actions');
const resourceAccess = require('./company-resource-access');
const { loadGmailClientForUser } = require('../../gmail-user-client');
const departmentPools = require('../department-pools');
const usageLedger = require('../usage-ledger');

function bounded(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validEmail(value) {
  const email = bounded(value, 320).toLowerCase();
  if (!email || /[\r\n]/.test(email)) return null;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

function safeSubject(value) {
  const subject = bounded(value, 240);
  return subject && !/[\r\n]/.test(subject) ? subject : '';
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function leadFingerprint(projectId, url) {
  return createHash('sha256').update(`${projectId}:${url}`).digest('hex');
}

async function persistResearchedLead({ prisma, data }) {
  const identity = {
    projectId_fingerprint: {
      projectId: data.projectId,
      fingerprint: data.fingerprint,
    },
  };
  try {
    return await prisma.codexCompanyLead.create({ data });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
  }

  const existing = await prisma.codexCompanyLead.findUnique({ where: identity });
  if (!existing) {
    const error = new Error('lead disappeared after a uniqueness conflict');
    error.code = 'CODEX_LEAD_CONFLICT';
    throw error;
  }

  await prisma.codexCompanyLead.update({
    where: { id: existing.id },
    data: {
      companyName: data.companyName,
      domain: data.domain,
      websiteUrl: data.websiteUrl,
      sourceTitle: data.sourceTitle,
      evidence: data.evidence,
      score: data.score,
      tags: data.tags,
      updatedAt: data.updatedAt,
    },
  });

  // Research may qualify a newly discovered lead, but it can never reopen a
  // human-reviewed, contacted, won/lost, or do-not-contact record. The status
  // predicate also protects against a concurrent user update.
  if (data.status === 'qualified') {
    await prisma.codexCompanyLead.updateMany({
      where: {
        id: existing.id,
        projectId: data.projectId,
        userId: data.userId,
        status: 'discovered',
      },
      data: { status: 'qualified' },
    });
  }
  return prisma.codexCompanyLead.findUnique({ where: { id: existing.id } });
}

function defaultSearch(query) {
  return require('../../agents/web-search').search(query, { maxResults: 10 });
}

async function researchLeads({
  prisma,
  project,
  companyContext,
  chatComplete,
  webSearch = defaultSearch,
  now = () => new Date(),
  departmentPoolId = null,
  env = process.env,
}) {
  const profile = companyContext?.profile || {};
  if (profile.autonomy?.research === false) {
    return { action: 'research_off', leads: [], queries: [] };
  }
  if (!bounded(profile.targetCustomer) || !bounded(profile.offer)) {
    return { action: 'profile_incomplete', leads: [], queries: [] };
  }
  const queryParts = [
    bounded(profile.targetCustomer, 180),
    bounded(profile.industry, 100),
    bounded(profile.market, 100),
    'empresas',
  ].filter(Boolean);
  const queries = [
    queryParts.join(' '),
    `${bounded(profile.targetCustomer, 160)} directorio empresas ${bounded(profile.market, 100)}`.trim(),
  ];
  const searches = await Promise.allSettled(queries.map((query) => webSearch(query)));
  const sourceRows = [];
  for (const search of searches) {
    if (search.status !== 'fulfilled') continue;
    for (const result of Array.isArray(search.value?.results) ? search.value.results : []) {
      const url = canonicalUrl(result?.url);
      if (!url || sourceRows.some((row) => row.url === url)) continue;
      sourceRows.push({
        title: bounded(result?.title, 240),
        url,
        snippet: bounded(result?.snippet, 600),
        source: bounded(result?.source, 80),
      });
      if (sourceRows.length >= 20) break;
    }
  }
  if (!sourceRows.length) return { action: 'no_results', leads: [], queries };

  const budget = await departmentPools.requireOperationBudget({
    prisma,
    project,
    departmentId: resourceAccess.SALES_DEPARTMENT_ID,
    departmentPoolId,
    env,
    now: now(),
  });
  const usagePool = budget.pool;
  const callId = usageLedger.createUsageCallId();
  const completion = await chatComplete({
    messages: [
      {
        role: 'system',
        content: [
          'Eres un analista B2B. Evalúa candidatos usando EXCLUSIVAMENTE las fuentes entregadas.',
          'No inventes personas, emails, teléfonos, ingresos ni necesidades.',
          'Responde SOLO JSON: {"leads":[{"sourceUrl":"URL exacta","companyName":"...","domain":"... o null","score":0-100,"evidence":"hecho verificable","tags":["..."]}]}.',
          'Incluye como máximo 10 candidatos y solo si existe evidencia de ajuste con el cliente objetivo.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Oferta: ${bounded(profile.offer, 400)}`,
          `Cliente objetivo: ${bounded(profile.targetCustomer, 400)}`,
          `Mercado: ${bounded(profile.market, 200) || 'no definido'}`,
          `Fuentes:\n${JSON.stringify(sourceRows)}`,
        ].join('\n\n'),
      },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  });
  await usageLedger.recordCompletionUsage({
    prisma,
    projectId: project.id,
    departmentPoolId: usagePool?.id || null,
    source: 'sales_research',
    sourceId: `lead-research:${project.id}`,
    completion,
    callId,
    env,
  });
  const parsed = extractJson(completion?.content || completion?.text);
  const byUrl = new Map(sourceRows.map((row) => [row.url, row]));
  const candidates = Array.isArray(parsed?.leads) ? parsed.leads : [];
  const leads = [];
  for (const candidate of candidates.slice(0, 10)) {
    const sourceUrl = canonicalUrl(candidate?.sourceUrl);
    const source = sourceUrl ? byUrl.get(sourceUrl) : null;
    const companyName = bounded(candidate?.companyName, 180);
    if (!source || !companyName) continue;
    const score = Math.max(0, Math.min(100, Number.parseInt(candidate?.score, 10) || 0));
    const data = {
      projectId: project.id,
      userId: project.userId,
      fingerprint: leadFingerprint(project.id, source.url),
      companyName,
      domain: bounded(candidate?.domain, 180) || null,
      websiteUrl: source.url,
      sourceUrl: source.url,
      sourceTitle: source.title || null,
      evidence: bounded(candidate?.evidence || source.snippet, 1200) || null,
      status: score >= 70 ? 'qualified' : 'discovered',
      score,
      tags: Array.isArray(candidate?.tags)
        ? candidate.tags.map((tag) => bounded(tag, 60)).filter(Boolean).slice(0, 12)
        : [],
      updatedAt: now(),
    };
    const row = await persistResearchedLead({ prisma, data });
    leads.push(row);
  }
  return {
    action: leads.length ? 'leads_saved' : 'no_qualified_results',
    leads,
    queries,
    sourceCount: sourceRows.length,
  };
}

async function prepareLeadOutreach({
  prisma,
  project,
  leadId,
  companyContext,
  chatComplete,
  gmailLoader = loadGmailClientForUser,
  env = process.env,
  now = () => new Date(),
  departmentPoolId = null,
}) {
  const lead = await prisma.codexCompanyLead.findFirst({
    where: { id: leadId, projectId: project.id, userId: project.userId },
  });
  if (!lead) return { action: 'lead_not_found', lead: null, record: null };
  if (lead.status === 'do_not_contact') return { action: 'do_not_contact', lead, record: null };
  const recipient = validEmail(lead.email);
  if (!recipient) return { action: 'lead_email_required', lead, record: null };
  const decision = await externalActions.decisionForAction({
    prisma,
    project,
    companyContext,
    kind: 'lead_outreach',
    env,
    now: now(),
  });
  if (!decision.allowed) return { action: decision.reason, lead, record: null, policy: decision };
  const existing = await externalActions.findExternalAction({
    prisma,
    project,
    kind: 'lead_outreach',
    targetRef: lead.id,
  });
  if (existing) {
    return {
      action: existing.status === 'completed' ? 'already_contacted' : 'outreach_already_prepared',
      lead,
      record: existing,
      policy: decision,
    };
  }

  const profile = companyContext?.profile || {};
  const budget = await departmentPools.requireOperationBudget({
    prisma,
    project,
    departmentId: resourceAccess.SALES_DEPARTMENT_ID,
    departmentPoolId,
    env,
    now: now(),
  });
  const usagePool = budget.pool;
  const callId = usageLedger.createUsageCallId();
  const completion = await chatComplete({
    messages: [
      {
        role: 'system',
        content: [
          'Redacta un primer correo comercial breve, honesto y personalizado.',
          'Usa únicamente los hechos entregados; no inventes relación previa, resultados, urgencia, descuentos ni datos personales.',
          'Incluye una salida fácil y respetuosa. Responde SOLO JSON: {"subject":"...","body":"..."}.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Empresa remitente: ${bounded(profile.companyName, 180)}`,
          `Oferta: ${bounded(profile.offer, 500)}`,
          `Cliente objetivo: ${bounded(profile.targetCustomer, 400)}`,
          `Prospecto: ${bounded(lead.companyName, 180)}`,
          `Evidencia pública: ${bounded(lead.evidence, 1000)}`,
          `Fuente: ${bounded(lead.sourceUrl, 1000)}`,
        ].join('\n'),
      },
    ],
    temperature: 0.3,
    maxTokens: 800,
  });
  await usageLedger.recordCompletionUsage({
    prisma,
    projectId: project.id,
    departmentPoolId: usagePool?.id || null,
    source: 'sales_outreach',
    sourceId: `lead-outreach:${lead.id}`,
    completion,
    callId,
    env,
  });
  const parsed = extractJson(completion?.content || completion?.text);
  const subject = safeSubject(parsed?.subject);
  const body = bounded(parsed?.body, 6000);
  if (!subject || !body) return { action: 'invalid_draft', lead, record: null, policy: decision };

  const ensured = await externalActions.ensureExternalAction({
    prisma,
    project,
    kind: 'lead_outreach',
    targetRef: lead.id,
    payload: {
      leadId: lead.id,
      to: recipient,
      subject,
      body,
      providerDraftId: null,
      sourceUrl: lead.sourceUrl,
    },
    status: decision.action === 'execute' ? 'approved' : 'pending_review',
  });
  let record = ensured.record;
  if (!ensured.created) {
    return {
      action: record.status === 'completed' ? 'already_contacted' : 'outreach_already_prepared',
      lead,
      record,
      policy: decision,
    };
  }

  let providerDraftId = null;
  let gmailClient = null;
  if (decision.action === 'review') {
    try {
      await resourceAccess.requireCompanyResourceAccess({
        prisma,
        project,
        departmentId: resourceAccess.SALES_DEPARTMENT_ID,
        resourceKey: resourceAccess.GMAIL_RESOURCE_KEY,
      });
      const loaded = await gmailLoader({ prisma, userId: project.userId });
      gmailClient = loaded.client;
      const draft = await gmailClient.createDraft({
        to: recipient,
        subject,
        body,
      });
      providerDraftId = draft.draftId || null;
      record = await externalActions.updateExternalActionPayload({
        prisma,
        project,
        actionId: record.id,
        patch: { providerDraftId },
      }) || record;
    } catch (error) {
      await externalActions.markExternalActionError({
        prisma,
        project,
        actionId: record.id,
        error,
      });
      return {
        action: 'draft_error',
        lead,
        record: { ...record, status: 'error', error: String(error?.message || error) },
        policy: decision,
      };
    }
  }
  await prisma.codexCompanyLead.updateMany({
    where: { id: lead.id, projectId: project.id, userId: project.userId },
    data: { status: decision.action === 'execute' ? 'qualified' : 'review' },
  });
  if (decision.action === 'execute') {
    const executed = await externalActions.executeExternalAction({
      prisma,
      project,
      actionId: record.id,
      gmailLoader: gmailClient ? async () => ({ client: gmailClient }) : gmailLoader,
      now,
    });
    return { action: executed.action, lead, record: executed.record, policy: decision };
  }
  return { action: 'outreach_review', lead, record, policy: decision };
}

module.exports = {
  canonicalUrl,
  extractJson,
  leadFingerprint,
  persistResearchedLead,
  prepareLeadOutreach,
  researchLeads,
  safeSubject,
  validEmail,
};
