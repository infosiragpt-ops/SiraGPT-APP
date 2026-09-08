'use strict';

/**
 * Shared operating context for CEO Office and every autonomous department.
 *
 * The profile stores user/company intent. Readiness is derived from runtime
 * evidence on every read so an LLM can never claim that Gmail, a social
 * account, a published site, or the code workspace is connected when it is not.
 */

const PROFILE_VERSION = 1;
const COMPANY_MODEL_VERSION = 1;
const SOUL_VERSION = 1;
const MAX_GAPS = 12;
const EXTERNAL_ACTION_MODES = Object.freeze(['review', 'auto', 'off']);
const { mutateProjectBrief } = require('./project-brief-store');
const businessAnalyzer = require('./business-analyzer');

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asBriefRecord(value) {
  const record = asRecord(value);
  if (Object.keys(record).length) return record;
  const objective = boundedText(value, 20_000);
  return objective ? { objective } : {};
}

function nullableText(value, max = 500) {
  const text = boundedText(value, max);
  return text || null;
}

function normalizeSocialUrls(value) {
  const source = Array.isArray(value)
    ? Object.fromEntries(value
      .map((item) => [boundedText(item?.platform, 40).toLowerCase(), item?.url])
      .filter(([platform]) => platform))
    : asRecord(value);
  return Object.fromEntries(
    Object.entries(source)
      .map(([platform, url]) => [
        boundedText(platform, 40).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
        nullableText(url, 500),
      ])
      .filter(([platform, url]) => platform && url)
      .slice(0, 20),
  );
}

function normalizeCompanyUrls(value, current = {}) {
  const source = asRecord(value);
  const previous = asRecord(current);
  return {
    web: Object.prototype.hasOwnProperty.call(source, 'web')
      ? nullableText(source.web, 500)
      : nullableText(previous.web, 500),
    landing: Object.prototype.hasOwnProperty.call(source, 'landing')
      ? nullableText(source.landing, 500)
      : nullableText(previous.landing, 500),
    socials: Object.prototype.hasOwnProperty.call(source, 'socials')
      ? normalizeSocialUrls(source.socials)
      : normalizeSocialUrls(previous.socials),
  };
}

function normalizeStage(value) {
  return ['new', 'existing', 'growing', 'unknown'].includes(value) ? value : 'unknown';
}

function normalizeExternalMode(value, fallback = 'review') {
  return EXTERNAL_ACTION_MODES.includes(value) ? value : fallback;
}

function normalizeAutonomy(value, current = {}) {
  const source = asRecord(value);
  const previous = asRecord(current);
  return {
    research: source.research == null ? previous.research !== false : source.research === true,
    codeChanges: normalizeExternalMode(source.codeChanges, normalizeExternalMode(previous.codeChanges, 'auto')),
    socialPublishing: normalizeExternalMode(source.socialPublishing, normalizeExternalMode(previous.socialPublishing, 'review')),
    socialReplies: normalizeExternalMode(source.socialReplies, normalizeExternalMode(previous.socialReplies, 'review')),
    emailReplies: normalizeExternalMode(source.emailReplies, normalizeExternalMode(previous.emailReplies, 'review')),
    leadOutreach: normalizeExternalMode(source.leadOutreach, normalizeExternalMode(previous.leadOutreach, 'review')),
  };
}

function fieldFromPatch(source, current, key, max) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return nullableText(current[key], max);
  return nullableText(source[key], max);
}

function mergeCompanyProfile(current, patch, {
  companyName = null,
  now = new Date(),
} = {}) {
  const previous = asRecord(current);
  const source = asRecord(patch);
  const nextCompanyName = fieldFromPatch(source, previous, 'companyName', 120)
    || nullableText(companyName, 120)
    || 'Empresa';
  const urls = normalizeCompanyUrls(source.urls, previous.urls);
  const websiteUrl = Object.prototype.hasOwnProperty.call(source, 'websiteUrl')
    ? nullableText(source.websiteUrl, 500)
    : Object.prototype.hasOwnProperty.call(asRecord(source.urls), 'web')
      ? urls.web
      : nullableText(previous.websiteUrl, 500) || urls.web;
  urls.web = websiteUrl;
  return {
    version: PROFILE_VERSION,
    companyName: nextCompanyName,
    stage: Object.prototype.hasOwnProperty.call(source, 'stage')
      ? normalizeStage(source.stage)
      : normalizeStage(previous.stage),
    mission: fieldFromPatch(source, previous, 'mission', 600),
    vision: fieldFromPatch(source, previous, 'vision', 600),
    offer: fieldFromPatch(source, previous, 'offer', 600),
    targetCustomer: fieldFromPatch(source, previous, 'targetCustomer', 600),
    businessModel: fieldFromPatch(source, previous, 'businessModel', 400),
    industry: fieldFromPatch(source, previous, 'industry', 240),
    market: fieldFromPatch(source, previous, 'market', 240),
    brandVoice: fieldFromPatch(source, previous, 'brandVoice', 300),
    websiteUrl,
    urls,
    salesProcess: fieldFromPatch(source, previous, 'salesProcess', 600),
    autonomy: normalizeAutonomy(source.autonomy, previous.autonomy),
    updatedAt: now.toISOString(),
  };
}

function profileFromCompanyRecord(company) {
  if (!company) return {};
  const brief = asRecord(company.brief);
  const urls = normalizeCompanyUrls(company.urls, brief.urls);
  return {
    ...brief,
    companyName: nullableText(company.name, 120) || nullableText(brief.companyName, 120),
    mission: nullableText(company.mission, 600) || nullableText(brief.mission, 600),
    vision: nullableText(company.vision, 600) || nullableText(brief.vision, 600),
    industry: nullableText(company.industry, 240) || nullableText(brief.industry, 240),
    websiteUrl: urls.web || nullableText(brief.websiteUrl, 500),
    urls,
  };
}

function readCompanyProfile(project, { now = new Date(), company = null } = {}) {
  const brief = asRecord(project?.brief);
  return mergeCompanyProfile({}, company
    ? profileFromCompanyRecord(company)
    : asRecord(brief.companyProfile), {
    companyName: project?.name,
    now,
  });
}

function companyIdForLink(linkId) {
  const id = boundedText(linkId, 140);
  return id ? `company_${id}` : null;
}

function companyDataFromProfile({ profile, project, link }) {
  const normalized = mergeCompanyProfile({}, profile, {
    companyName: project?.name,
  });
  return {
    userId: project.userId,
    projectId: link.projectId,
    organizationId: link?.organizationId || project.organizationId || null,
    name: normalized.companyName,
    mission: normalized.mission,
    vision: normalized.vision,
    urls: normalized.urls,
    industry: normalized.industry,
    brief: normalized,
  };
}

async function loadCompanyLink({ prisma, projectId }) {
  if (!prisma?.companyCodexProjectLink?.findUnique || !projectId) return null;
  return prisma.companyCodexProjectLink.findUnique({
    where: { codexProjectId: projectId },
    select: {
      id: true,
      projectId: true,
      codexProjectId: true,
      companyId: true,
      organizationId: true,
      company: {
        select: {
          id: true,
          userId: true,
          organizationId: true,
          name: true,
          mission: true,
          vision: true,
          urls: true,
          industry: true,
          brief: true,
          updatedAt: true,
        },
      },
    },
  }).catch(() => null);
}

async function upsertCompanyForLink({
  prisma,
  project,
  profile,
  link = null,
}) {
  if (
    !prisma?.company?.upsert
    || !prisma?.companyCodexProjectLink?.update
    || !project?.id
  ) return null;
  const resolvedLink = link || await loadCompanyLink({ prisma, projectId: project.id });
  if (!resolvedLink?.id) return null;
  const id = resolvedLink.companyId || companyIdForLink(resolvedLink.id);
  if (!id) return null;
  const data = companyDataFromProfile({ profile, project, link: resolvedLink });
  const company = await prisma.company.upsert({
    where: { projectId: resolvedLink.projectId },
    create: { id, ...data },
    update: data,
  });
  if (resolvedLink.companyId !== company.id) {
    await prisma.companyCodexProjectLink.update({
      where: { id: resolvedLink.id },
      data: { companyId: company.id },
    });
  }
  return company;
}

async function ensureCompanyForAssociation({
  prisma,
  companyProject,
  codexProject,
  link,
  now = new Date(),
}) {
  if (!companyProject || !codexProject || !link) return null;
  const profile = mergeCompanyProfile(
    {},
    asRecord(asRecord(codexProject.brief).companyProfile),
    { companyName: companyProject.name, now },
  );
  return upsertCompanyForLink({
    prisma,
    project: {
      ...codexProject,
      userId: companyProject.userId,
      organizationId: link.organizationId || companyProject.organizationId || null,
      name: companyProject.name,
    },
    profile,
    link,
  });
}

async function writeCompanyProfile({
  prisma,
  project,
  patch,
  now = new Date(),
}) {
  if (!prisma?.codexProject?.update || !project?.id) return null;
  const link = await loadCompanyLink({ prisma, projectId: project.id });
  const profile = mergeCompanyProfile(
    readCompanyProfile(project, { now, company: link?.company || null }),
    patch,
    { companyName: project.name, now },
  );
  await upsertCompanyForLink({
    prisma,
    project,
    profile,
    link,
  });
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief, sourceProject) => {
      const source = Object.keys(brief).length
        ? asBriefRecord(brief)
        : asBriefRecord(sourceProject.brief);
      return { ...source, companyProfile: profile };
    },
  });
  return profile;
}

function renderCompanySoul(profile) {
  const normalized = mergeCompanyProfile({}, profile);
  const socials = Object.entries(asRecord(normalized.urls?.socials));
  const presence = [
    normalized.urls?.web ? `- Web: ${normalized.urls.web}` : null,
    normalized.urls?.landing ? `- Landing: ${normalized.urls.landing}` : null,
    ...socials.map(([platform, url]) => `- ${platform}: ${url}`),
  ].filter(Boolean);
  return [
    `# SOUL.md — ${normalized.companyName}`,
    '',
    '> Contexto de empresa generado por SiraGPT desde el modelo Company. Es identidad operativa, no evidencia de conexiones o publicaciones.',
    '',
    '## Identidad',
    `- Empresa: ${normalized.companyName}`,
    `- Industria: ${normalized.industry || 'no confirmada'}`,
    `- Etapa: ${normalized.stage}`,
    '',
    '## Propósito',
    `- Misión: ${normalized.mission || 'no confirmada'}`,
    `- Visión: ${normalized.vision || 'no confirmada'}`,
    '',
    '## Negocio',
    `- Oferta: ${normalized.offer || 'no confirmada'}`,
    `- Cliente objetivo: ${normalized.targetCustomer || 'no confirmado'}`,
    `- Modelo de negocio: ${normalized.businessModel || 'no confirmado'}`,
    `- Mercado: ${normalized.market || 'no confirmado'}`,
    `- Voz de marca: ${normalized.brandVoice || 'no confirmada'}`,
    '',
    '## Presencia declarada',
    ...(presence.length ? presence : ['- No hay URLs confirmadas.']),
    '',
    '## Límites',
    '- Distingue hechos verificados de hipótesis y pide evidencia antes de afirmar resultados.',
    '- Investigar y preparar borradores no autoriza publicar, enviar correos ni contactar leads.',
    '- Toda acción externa conserva la política de conexión, consentimiento, revisión y auditoría de la empresa.',
  ].join('\n').slice(0, 8_000);
}

async function loadCompanySoul({
  prisma,
  project,
  now = new Date(),
}) {
  if (!project) return null;
  const link = await loadCompanyLink({ prisma, projectId: project.id });
  const profile = readCompanyProfile(project, {
    now,
    company: link?.company || null,
  });
  return {
    version: SOUL_VERSION,
    filename: 'SOUL.md',
    companyId: link?.company?.id || link?.companyId || null,
    source: link?.company ? 'company_model' : 'legacy_company_profile',
    content: renderCompanySoul(profile),
  };
}

function normalizeSocialConnections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const row of value) {
    const platform = boundedText(row?.platform, 40).toLowerCase();
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    const scopes = Array.isArray(row?.scopes)
      ? row.scopes
        .map((scope) => boundedText(scope, 120).toLowerCase())
        .filter(Boolean)
      : boundedText(row?.scopes, 1000)
        .split(/[\s,]+/)
        .map((scope) => scope.toLowerCase())
        .filter(Boolean);
    const granted = new Set(scopes);
    const conversationsReady = platform === 'facebook'
      ? granted.has('pages_read_engagement') && granted.has('pages_manage_engagement')
      : platform === 'linkedin'
        ? (
          granted.has('r_member_social') && granted.has('w_member_social')
        ) || (
          granted.has('r_organization_social') && granted.has('w_organization_social')
        )
        : platform === 'x'
          ? granted.has('tweet.read') && granted.has('tweet.write') && granted.has('users.read')
          : false;
    result.push({
      platform,
      accountName: nullableText(row?.accountName, 120),
      scopes: [...new Set(scopes)].slice(0, 30),
      conversationsReady,
    });
  }
  return result.slice(0, 20);
}

function readinessItem(id, label, status, evidence, action) {
  return { id, label, status, evidence, action };
}

function deriveCompanyReadiness({
  project,
  profile,
  socialConnections = [],
  gmailConnected = false,
} = {}) {
  const normalizedProfile = mergeCompanyProfile({}, profile, {
    companyName: project?.name,
  });
  const brief = asRecord(project?.brief);
  const publication = asRecord(brief.publication);
  const social = normalizeSocialConnections(socialConnections);
  const publishedUrl = nullableText(publication.url, 500);
  const websiteUrl = publishedUrl || normalizedProfile.websiteUrl;
  const workspaceReady = project?.status === 'ready' && Boolean(project?.workspacePath);

  const areas = [
    readinessItem(
      'purpose',
      'Misión y visión',
      normalizedProfile.mission && normalizedProfile.vision ? 'ready' : 'needs_attention',
      normalizedProfile.mission && normalizedProfile.vision
        ? 'Misión y visión definidas en el perfil operativo.'
        : 'Falta definir misión o visión con evidencia del negocio.',
      'CEO Office debe consolidar la misión y visión antes de ampliar el plan.',
    ),
    readinessItem(
      'customer',
      'Cliente y oferta',
      normalizedProfile.targetCustomer && normalizedProfile.offer ? 'ready' : 'needs_attention',
      normalizedProfile.targetCustomer && normalizedProfile.offer
        ? 'Oferta y cliente objetivo definidos.'
        : 'La oferta o el cliente objetivo todavía no están definidos.',
      'Investigar el mercado y definir una oferta verificable para un cliente concreto.',
    ),
    readinessItem(
      'software',
      'Software propio',
      workspaceReady ? 'ready' : 'blocked',
      workspaceReady
        ? `Workspace aislado disponible: ${project.workspacePath}.`
        : `Proyecto en estado ${boundedText(project?.status, 40) || 'desconocido'}; no hay workspace ejecutable confirmado.`,
      'Producto e Ingeniería debe recuperar o crear un workspace ejecutable y verificable.',
    ),
    readinessItem(
      'website',
      'Sitio web',
      websiteUrl ? 'ready' : 'needs_attention',
      websiteUrl ? `Sitio confirmado: ${websiteUrl}.` : 'No existe una publicación o URL empresarial confirmada.',
      'Crear y publicar una página de destino alineada con la oferta.',
    ),
    readinessItem(
      'social',
      'Redes sociales',
      social.length ? 'ready' : 'needs_attention',
      social.length
        ? `Cuentas conectadas: ${social.map((item) => item.platform).join(', ')}.`
        : 'No hay cuentas sociales OAuth conectadas.',
      'Conectar cuentas desde Recursos; preparar borradores mientras no exista autorización.',
    ),
    readinessItem(
      'email',
      'Correo del negocio',
      gmailConnected ? 'ready' : 'needs_attention',
      gmailConnected ? 'Gmail conectado mediante credenciales cifradas.' : 'No hay una cuenta Gmail conectada.',
      'Conectar el correo desde Recursos antes de leer o responder mensajes.',
    ),
    readinessItem(
      'sales',
      'Proceso comercial',
      normalizedProfile.salesProcess ? 'ready' : 'needs_attention',
      normalizedProfile.salesProcess
        ? 'Proceso comercial descrito en el perfil operativo.'
        : 'No existe un proceso comercial confirmado.',
      'Definir etapas, criterios de calificación, seguimiento y cierre antes de automatizar alcance.',
    ),
  ];
  const readyCount = areas.filter((item) => item.status === 'ready').length;
  const gaps = areas
    .filter((item) => item.status !== 'ready')
    .map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      action: item.action,
    }))
    .slice(0, MAX_GAPS);

  return {
    score: Math.round((readyCount / areas.length) * 100),
    readyCount,
    total: areas.length,
    areas,
    gaps,
    evidence: {
      publishedUrl,
      workspaceReady,
      socialConnections: social,
      gmailConnected: Boolean(gmailConnected),
    },
  };
}

async function loadCompanyOperatingContext({
  prisma,
  project,
  now = new Date(),
} = {}) {
  const assignmentStorageAvailable = Boolean(
    prisma?.companyCodexProjectLink?.findUnique
    && prisma?.projectConnectorAssignment?.findMany,
  );
  const link = assignmentStorageAvailable
    ? await loadCompanyLink({ prisma, projectId: project.id })
    : null;
  const profile = readCompanyProfile(project, { now, company: link?.company || null });
  const assignedConnectorRows = link
    ? await prisma.projectConnectorAssignment.findMany({
      where: { projectId: link.projectId, status: 'active' },
      select: {
        connectorAccount: {
          select: {
            id: true,
            provider: true,
            status: true,
          },
        },
      },
    }).catch(() => [])
    : [];
  const assignedConnectors = assignedConnectorRows
    .map((row) => row?.connectorAccount)
    .filter((account) => account?.status === 'connected');
  const assignedProviders = new Set(assignedConnectors.map((account) => account.provider));
  const [allConnections, user] = await Promise.all([
    prisma?.socialConnection?.findMany
      ? prisma.socialConnection.findMany({
        where: { userId: project.userId },
        select: { platform: true, accountName: true, scopes: true },
      }).catch(() => [])
      : [],
    prisma?.user?.findUnique
      ? prisma.user.findUnique({
        where: { id: project.userId },
        select: { gmailTokens: true },
      }).catch(() => null)
      : null,
  ]);
  const connections = assignmentStorageAvailable
    ? allConnections.filter((connection) => assignedProviders.has(connection.platform))
    : allConnections;
  const gmailConnected = Boolean(user?.gmailTokens) && (
    !assignmentStorageAvailable || assignedProviders.has('gmail')
  );
  const readiness = deriveCompanyReadiness({
    project,
    profile,
    socialConnections: connections,
    gmailConnected,
  });
  readiness.evidence.connectorAssignment = {
    enforced: assignmentStorageAvailable,
    companyProjectId: link?.projectId || null,
    providers: [...assignedProviders].sort(),
    accountIds: assignedConnectors.map((account) => account.id).sort(),
  };
  const context = {
    companyId: link?.company?.id || link?.companyId || null,
    profile,
    readiness,
    businessAudit: businessAnalyzer.readBusinessAudit(project),
    soul: {
      version: SOUL_VERSION,
      filename: 'SOUL.md',
      source: link?.company ? 'company_model' : 'legacy_company_profile',
      content: renderCompanySoul(profile),
    },
    okrs: require('./progress-ledger').readObjectivePortfolio(project),
    safeguards: {
      externalActionsRequireConnection: true,
      defaultExternalMode: 'review',
      socialPublishing: profile.autonomy.socialPublishing,
      socialReplies: profile.autonomy.socialReplies,
      emailReplies: profile.autonomy.emailReplies,
      leadOutreach: profile.autonomy.leadOutreach,
    },
  };
  context.portfolio = require('./company-mission-orchestrator')
    .deriveCompanyMissionPortfolio({ project, context, now });
  return context;
}

function formatCompanyContext(context) {
  const source = asRecord(context);
  const profile = asRecord(source.profile);
  const readiness = asRecord(source.readiness);
  const gaps = Array.isArray(readiness.gaps) ? readiness.gaps : [];
  const areas = Array.isArray(readiness.areas) ? readiness.areas : [];
  const portfolio = asRecord(source.portfolio);
  const businessAudit = businessAnalyzer.formatBusinessAudit(source.businessAudit);
  const missions = Array.isArray(portfolio.missions) ? portfolio.missions : [];
  const okrs = asRecord(source.okrs);
  const objectives = Array.isArray(okrs.objectives) ? okrs.objectives : [];
  const priorities = missions
    .filter((item) => ['ready_to_execute', 'review_required'].includes(item?.status))
    .slice(0, 5);
  return [
    source.soul?.content
      ? `SOUL.md generado:\n${boundedText(source.soul.content, 8_000)}`
      : null,
    `Empresa: ${boundedText(profile.companyName, 120) || 'sin nombre confirmado'}`,
    `Etapa: ${normalizeStage(profile.stage)}`,
    `Misión: ${boundedText(profile.mission, 600) || 'no confirmada'}`,
    `Visión: ${boundedText(profile.vision, 600) || 'no confirmada'}`,
    `Oferta: ${boundedText(profile.offer, 600) || 'no confirmada'}`,
    `Cliente objetivo: ${boundedText(profile.targetCustomer, 600) || 'no confirmado'}`,
    `Preparación operativa: ${Number(readiness.score) || 0}%`,
    objectives.length
      ? `OKR revisados por CEO Office (revisión ${Number(okrs.revision) || 0}):\n${objectives.slice(0, 5).map((objective) => (
        `- [P${Number(objective.priority) || '-'} · ${boundedText(objective.status, 40)}] ${boundedText(objective.title, 180)}`
        + `${Array.isArray(objective.keyResults) && objective.keyResults.length ? ` (${objective.keyResults.length} KR)` : ''}`
      )).join('\n')}`
      : 'OKR revisados por CEO Office: aún no existe una cartera estructurada.',
    gaps.length
      ? `Brechas verificadas:\n${gaps.map((gap) => {
        const area = areas.find((item) => item?.id === gap?.id);
        const evidence = boundedText(area?.evidence, 500);
        return `- ${boundedText(gap.label, 100)}: ${evidence || 'sin evidencia confirmada'} Próximo paso: ${boundedText(gap.action, 500)}`;
      }).join('\n')}`
      : 'Brechas verificadas: ninguna pendiente.',
    priorities.length
      ? `Misiones CEO prioritarias:\n${priorities.map((item) => (
        `- [P${Number(item.priority) || '-'}] ${boundedText(item.title, 180)} → ${boundedText(item.departmentName, 160)} (${boundedText(item.status, 80)})`
      )).join('\n')}`
      : 'Misiones CEO prioritarias: ninguna lista para ejecución.',
    businessAudit || null,
    'Regla: no conviertas una hipótesis en hecho; las conexiones y publicaciones solo son reales cuando aparecen en la evidencia de preparación.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  COMPANY_MODEL_VERSION,
  PROFILE_VERSION,
  SOUL_VERSION,
  EXTERNAL_ACTION_MODES,
  companyDataFromProfile,
  companyIdForLink,
  deriveCompanyReadiness,
  ensureCompanyForAssociation,
  formatCompanyContext,
  loadCompanyLink,
  loadCompanyOperatingContext,
  loadCompanySoul,
  mergeCompanyProfile,
  normalizeAutonomy,
  normalizeCompanyUrls,
  normalizeSocialConnections,
  profileFromCompanyRecord,
  readCompanyProfile,
  renderCompanySoul,
  upsertCompanyForLink,
  writeCompanyProfile,
};
