'use strict';

/**
 * Shared operating context for CEO Office and every autonomous department.
 *
 * The profile stores user/company intent. Readiness is derived from runtime
 * evidence on every read so an LLM can never claim that Gmail, a social
 * account, a published site, or the code workspace is connected when it is not.
 */

const PROFILE_VERSION = 1;
const MAX_GAPS = 12;
const EXTERNAL_ACTION_MODES = Object.freeze(['review', 'auto', 'off']);

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
    websiteUrl: fieldFromPatch(source, previous, 'websiteUrl', 500),
    salesProcess: fieldFromPatch(source, previous, 'salesProcess', 600),
    autonomy: normalizeAutonomy(source.autonomy, previous.autonomy),
    updatedAt: now.toISOString(),
  };
}

function readCompanyProfile(project, { now = new Date() } = {}) {
  const brief = asRecord(project?.brief);
  return mergeCompanyProfile({}, asRecord(brief.companyProfile), {
    companyName: project?.name,
    now,
  });
}

async function writeCompanyProfile({
  prisma,
  project,
  patch,
  now = new Date(),
}) {
  if (!prisma?.codexProject?.update || !project?.id) return null;
  const fresh = prisma.codexProject.findUnique
    ? await prisma.codexProject.findUnique({ where: { id: project.id } }).catch(() => null)
    : null;
  const sourceProject = fresh || project;
  const brief = asBriefRecord(sourceProject.brief);
  const profile = mergeCompanyProfile(brief.companyProfile, patch, {
    companyName: sourceProject.name,
    now,
  });
  await prisma.codexProject.update({
    where: { id: project.id },
    data: { brief: { ...brief, companyProfile: profile } },
  });
  return profile;
}

function normalizeSocialConnections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const row of value) {
    const platform = boundedText(row?.platform, 40).toLowerCase();
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    result.push({
      platform,
      accountName: nullableText(row?.accountName, 120),
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
  const profile = readCompanyProfile(project, { now });
  const [connections, user] = await Promise.all([
    prisma?.socialConnection?.findMany
      ? prisma.socialConnection.findMany({
        where: { userId: project.userId },
        select: { platform: true, accountName: true },
      }).catch(() => [])
      : [],
    prisma?.user?.findUnique
      ? prisma.user.findUnique({
        where: { id: project.userId },
        select: { gmailTokens: true },
      }).catch(() => null)
      : null,
  ]);
  const readiness = deriveCompanyReadiness({
    project,
    profile,
    socialConnections: connections,
    gmailConnected: Boolean(user?.gmailTokens),
  });
  const context = {
    profile,
    readiness,
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
  const missions = Array.isArray(portfolio.missions) ? portfolio.missions : [];
  const priorities = missions
    .filter((item) => ['ready_to_execute', 'review_required'].includes(item?.status))
    .slice(0, 5);
  return [
    `Empresa: ${boundedText(profile.companyName, 120) || 'sin nombre confirmado'}`,
    `Etapa: ${normalizeStage(profile.stage)}`,
    `Misión: ${boundedText(profile.mission, 600) || 'no confirmada'}`,
    `Visión: ${boundedText(profile.vision, 600) || 'no confirmada'}`,
    `Oferta: ${boundedText(profile.offer, 600) || 'no confirmada'}`,
    `Cliente objetivo: ${boundedText(profile.targetCustomer, 600) || 'no confirmado'}`,
    `Preparación operativa: ${Number(readiness.score) || 0}%`,
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
    'Regla: no conviertas una hipótesis en hecho; las conexiones y publicaciones solo son reales cuando aparecen en la evidencia de preparación.',
  ].join('\n');
}

module.exports = {
  PROFILE_VERSION,
  EXTERNAL_ACTION_MODES,
  deriveCompanyReadiness,
  formatCompanyContext,
  loadCompanyOperatingContext,
  mergeCompanyProfile,
  normalizeAutonomy,
  normalizeSocialConnections,
  readCompanyProfile,
  writeCompanyProfile,
};
