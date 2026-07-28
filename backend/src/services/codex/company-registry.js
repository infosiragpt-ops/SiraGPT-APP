'use strict';

const operatingProfile = require('./company-operating-profile');

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function companyData({ codexProject, linkedProject }) {
  const profile = operatingProfile.readCompanyProfile(codexProject);
  return {
    userId: codexProject.userId,
    projectId: linkedProject.id,
    name: boundedText(profile.companyName, 120) || boundedText(linkedProject.name, 120) || 'Empresa',
    mission: boundedText(profile.mission, 2_000) || null,
    vision: boundedText(profile.vision, 2_000) || null,
    industry: boundedText(profile.industry, 240) || null,
    urls: {
      web: boundedText(profile.websiteUrl, 1_000) || null,
      socials: [],
    },
    metadata: {
      profileVersion: profile.version,
      stage: profile.stage,
      offer: profile.offer,
      targetCustomer: profile.targetCustomer,
      businessModel: profile.businessModel,
      market: profile.market,
      brandVoice: profile.brandVoice,
      salesProcess: profile.salesProcess,
      autonomy: profile.autonomy,
    },
  };
}

async function ensureCompanyForCodexProject({ prisma, codexProject }) {
  if (
    !codexProject?.id
    || !prisma?.companyCodexProjectLink?.findUnique
    || !prisma?.company?.upsert
  ) return null;
  const link = await prisma.companyCodexProjectLink.findUnique({
    where: { codexProjectId: codexProject.id },
    include: { project: true },
  });
  if (!link?.project || link.project.userId !== codexProject.userId) return null;
  const data = companyData({ codexProject, linkedProject: link.project });
  return prisma.company.upsert({
    where: { projectId: link.project.id },
    create: data,
    update: {
      name: data.name,
      mission: data.mission,
      vision: data.vision,
      industry: data.industry,
      urls: data.urls,
      metadata: data.metadata,
    },
  });
}

function formatCompanySoul(company) {
  if (!company) return '';
  const urls = asRecord(company.urls);
  const metadata = asRecord(company.metadata);
  return [
    '## Company SOUL.md',
    `Nombre: ${boundedText(company.name, 120) || 'Empresa'}`,
    `Misión: ${boundedText(company.mission, 2_000) || 'no confirmada'}`,
    `Visión: ${boundedText(company.vision, 2_000) || 'no confirmada'}`,
    `Industria: ${boundedText(company.industry, 240) || 'no confirmada'}`,
    `Sitio: ${boundedText(urls.web, 1_000) || 'no conectado'}`,
    `Oferta: ${boundedText(metadata.offer, 600) || 'no confirmada'}`,
    `Cliente objetivo: ${boundedText(metadata.targetCustomer, 600) || 'no confirmado'}`,
    `Voz de marca: ${boundedText(metadata.brandVoice, 300) || 'no confirmada'}`,
    'Este SOUL pertenece a la empresa y se aplica a TODOS sus departamentos y agentes.',
    'No inventes hechos, conexiones, publicaciones, ventas ni mensajes. Las acciones externas quedan en revisión salvo autorización explícita y auditable.',
  ].join('\n');
}

async function loadCompanySoul({ prisma, codexProject }) {
  const company = await ensureCompanyForCodexProject({ prisma, codexProject });
  return {
    company,
    prompt: formatCompanySoul(company),
  };
}

module.exports = {
  companyData,
  ensureCompanyForCodexProject,
  formatCompanySoul,
  loadCompanySoul,
};
