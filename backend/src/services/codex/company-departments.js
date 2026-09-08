'use strict';

/**
 * Persistent company structure for /code.
 *
 * Departments are stored in CodexProject.brief.companyDepartments so the
 * company survives browser changes and the proactive backend can actually use
 * units created by the user. `desiredAgents` is logical capacity; durable
 * DepartmentPool rows hold bounded physical capacity for isolated worktree
 * writers.
 *
 * Built-in edits/hides live in brief.companyDepartmentOverrides and
 * brief.companyDepartmentHidden so core units can be customized without
 * duplicating them as custom departments.
 */

const MAX_CUSTOM_DEPARTMENTS = 40;
const MAX_AGENTS_PER_DEPARTMENT = 1000;
const {
  coerceBriefRecord,
  mutateProjectBrief,
} = require('./project-brief-store');
const departmentPools = require('./department-pools');

const BUILT_IN_DEPARTMENTS = Object.freeze([
  {
    id: 'ceo-office',
    name: 'CEO Office',
    mission: 'Define prioridades, conserva decisiones, mantiene mision y vision y coordina todo el portafolio de trabajo.',
    description: 'Direccion, objetivos, decisiones y coordinacion global.',
    keywords: ['ceo', 'direccion', 'estrategia', 'mision', 'vision', 'okr'],
    kind: 'coordination',
    desiredAgents: 4,
  },
  {
    id: 'agent-infrastructure',
    name: 'Infraestructura de Agentes',
    mission: 'Mejora orquestacion, runners, aislamiento, memoria, herramientas y continuidad operativa.',
    description: 'Orquestacion, runners, aislamiento y continuidad.',
    keywords: ['agente', 'runner', 'sandbox', 'infraestructura', 'orquestacion'],
    kind: 'engineering',
    desiredAgents: 12,
  },
  {
    id: 'product-engineering',
    name: 'Producto e Ingenieria',
    mission: 'Construye producto full-stack verificable, mantiene arquitectura, UX, datos, APIs y calidad de entrega.',
    description: 'Arquitectura, producto full-stack y entrega verificable.',
    keywords: ['producto', 'frontend', 'backend', 'base de datos', 'codigo', 'preview'],
    kind: 'engineering',
    desiredAgents: 24,
  },
  {
    id: 'engineering-01',
    name: 'INGENIEROS 01',
    mission: 'Implementa el frente principal del portafolio tecnico con cambios incrementales y gates verdes.',
    description: 'Implementacion principal y evolucion del producto.',
    keywords: ['ingenieros 01', 'ingenieria 01', 'equipo 1'],
    kind: 'engineering',
    desiredAgents: 16,
  },
  {
    id: 'engineering-02',
    name: 'INGENIEROS 02',
    mission: 'Audita, prueba, depura e integra el trabajo antes de promoverlo.',
    description: 'QA, depuracion e integracion final.',
    keywords: ['ingenieros 02', 'ingenieria 02', 'qa', 'test', 'debug'],
    kind: 'engineering',
    desiredAgents: 12,
  },
  {
    id: 'market-intelligence',
    name: 'Inteligencia de Mercado',
    mission: 'Investiga mercado, competencia, demanda y evidencia publica para orientar decisiones sin inventar datos.',
    description: 'Investigacion real de mercado, competencia y oportunidades.',
    keywords: ['mercado', 'competencia', 'investigacion', 'tendencias', 'oportunidades'],
    kind: 'research',
    desiredAgents: 20,
  },
  {
    id: 'sales',
    name: 'Ventas',
    mission: 'Descubre y califica clientes potenciales, prepara seguimiento y avanza oportunidades bajo la politica comercial.',
    description: 'Prospeccion, calificacion, seguimiento y cierre.',
    keywords: ['ventas', 'clientes', 'leads', 'prospectos', 'crm', 'cierre'],
    kind: 'external',
    desiredAgents: 24,
  },
  {
    id: 'customer-success',
    name: 'Clientes y Soporte',
    mission: 'Revisa conversaciones pendientes, prioriza solicitudes y prepara respuestas contextuales con trazabilidad.',
    description: 'Correo, soporte, exito del cliente y respuestas.',
    keywords: ['cliente', 'soporte', 'correo', 'gmail', 'respuesta', 'comentario'],
    kind: 'external',
    desiredAgents: 16,
  },
  {
    id: 'growth-engines',
    name: 'Motores de Crecimiento y Distribucion',
    mission: 'Mejora adquisicion, activacion, retencion, distribucion y monetizacion con metricas observables.',
    description: 'Adquisicion, distribucion y crecimiento medible.',
    keywords: ['growth', 'crecimiento', 'distribucion', 'monetizacion', 'retencion'],
    kind: 'research',
    desiredAgents: 16,
  },
  {
    id: 'marketing',
    name: 'Marketing',
    mission: 'Planifica contenido y campanas; publica solo mediante cuentas conectadas y la politica explicita del usuario.',
    description: 'Posicionamiento, contenido y campanas medibles.',
    keywords: ['marketing', 'campana', 'contenido', 'seo', 'social'],
    kind: 'external',
    desiredAgents: 12,
  },
  {
    id: 'website-distribution',
    name: 'Web y Distribucion',
    mission: 'Crea, publica, mide y mejora el sitio, la landing y los canales digitales de la empresa.',
    description: 'Sitio, landing, publicacion, SEO y conversion.',
    keywords: ['web', 'sitio', 'landing', 'publicacion', 'seo', 'conversion'],
    kind: 'engineering',
    desiredAgents: 12,
  },
  {
    id: 'integrations',
    name: 'Integraciones y Conectores',
    mission: 'Conecta APIs, canales, correo, redes, MCP y automatizaciones con controles de seguridad.',
    description: 'APIs, canales, conectores y automatizaciones.',
    keywords: ['integracion', 'api', 'conector', 'mcp', 'oauth', 'webhook'],
    kind: 'engineering',
    desiredAgents: 12,
  },
  {
    id: 'localization',
    name: 'Localizacion e IA Transcultural',
    mission: 'Adapta idioma, accesibilidad, region, cultura y oferta a cada mercado.',
    description: 'Idiomas, accesibilidad y adaptacion de mercado.',
    keywords: ['localizacion', 'idioma', 'traduccion', 'accesibilidad', 'region'],
    kind: 'research',
    desiredAgents: 8,
  },
  {
    id: 'trust',
    name: 'Confianza, Privacidad y Cumplimiento',
    mission: 'Protege datos, permisos, privacidad, auditoria, seguridad y cumplimiento.',
    description: 'Seguridad, privacidad, auditoria y cumplimiento.',
    keywords: ['seguridad', 'privacidad', 'cumplimiento', 'auditoria', 'permiso'],
    kind: 'research',
    desiredAgents: 8,
  },
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function slug(value) {
  return boundedText(value, 100)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function boundedAgents(value, fallback = 4) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_AGENTS_PER_DEPARTMENT, parsed))
    : fallback;
}

function normalizeDepartment(value, { custom = true, index = 0 } = {}) {
  const source = asRecord(value);
  const name = boundedText(source.name, 90);
  if (!name) return null;
  const id = slug(source.id || name) || `department-${index + 1}`;
  const keywords = Array.isArray(source.keywords)
    ? [...new Set(source.keywords.map((item) => boundedText(item, 60).toLowerCase()).filter(Boolean))].slice(0, 20)
    : name.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return {
    id: custom && !id.startsWith('custom-') ? `custom-${id}` : id,
    name,
    mission: boundedText(source.mission, 800)
      || `Cumple la mision de ${name} y propone trabajo incremental alineado con los objetivos de CEO Office.`,
    description: boundedText(source.description, 240) || 'Departamento personalizado.',
    keywords,
    kind: ['coordination', 'engineering', 'research', 'external'].includes(source.kind)
      ? source.kind
      : 'research',
    desiredAgents: boundedAgents(source.desiredAgents, 4),
    custom: Boolean(custom),
    enabled: source.enabled !== false,
  };
}

function normalizeCustomDepartments(value) {
  if (!Array.isArray(value)) return [];
  const builtInIds = new Set(BUILT_IN_DEPARTMENTS.map((item) => item.id));
  const seen = new Set();
  const rows = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = normalizeDepartment(value[index], { custom: true, index });
    if (!row || builtInIds.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= MAX_CUSTOM_DEPARTMENTS) break;
  }
  return rows;
}

function normalizeOverrides(value) {
  const source = asRecord(value);
  const out = {};
  for (const [rawId, raw] of Object.entries(source)) {
    const key = slug(rawId);
    if (!key) continue;
    const row = asRecord(raw);
    const patch = {};
    if (typeof row.name === 'string' && row.name.trim()) patch.name = boundedText(row.name, 90);
    if (typeof row.mission === 'string') patch.mission = boundedText(row.mission, 800);
    if (typeof row.description === 'string') patch.description = boundedText(row.description, 240);
    if (Array.isArray(row.keywords)) {
      patch.keywords = [...new Set(
        row.keywords.map((item) => boundedText(item, 60).toLowerCase()).filter(Boolean),
      )].slice(0, 20);
    }
    if (['coordination', 'engineering', 'research', 'external'].includes(row.kind)) {
      patch.kind = row.kind;
    }
    if (row.desiredAgents != null) patch.desiredAgents = boundedAgents(row.desiredAgents, 4);
    if (Object.keys(patch).length > 0) out[key] = patch;
  }
  return out;
}

function normalizeHidden(value) {
  if (!Array.isArray(value)) return [];
  const builtInIds = new Set(BUILT_IN_DEPARTMENTS.map((item) => item.id));
  return [...new Set(
    value
      .map((item) => slug(item))
      .filter((id) => id && id !== 'ceo-office' && builtInIds.has(id)),
  )];
}

function applyOverride(base, override) {
  const patch = asRecord(override);
  if (!Object.keys(patch).length) return base;
  return {
    ...base,
    ...patch,
    id: base.id,
    custom: Boolean(base.custom),
    enabled: base.enabled !== false,
  };
}

function readDepartments(project) {
  const brief = coerceBriefRecord(project?.brief);
  const custom = normalizeCustomDepartments(brief.companyDepartments);
  const overrides = normalizeOverrides(brief.companyDepartmentOverrides);
  const hidden = new Set(normalizeHidden(brief.companyDepartmentHidden));
  const builtIns = BUILT_IN_DEPARTMENTS
    .filter((item) => !hidden.has(item.id))
    .map((item) => applyOverride(
      { ...item, custom: false, enabled: true },
      overrides[item.id],
    ));
  return [
    ...builtIns,
    ...custom.map((item) => applyOverride(item, overrides[item.id])),
  ];
}

function capacitySummary(departments, pools = []) {
  const enabled = (Array.isArray(departments) ? departments : []).filter((item) => item?.enabled !== false);
  const logicalAgents = enabled.reduce((sum, item) => sum + boundedAgents(item?.desiredAgents, 1), 0);
  const physical = departmentPools.poolCapacity(pools);
  return {
    departments: enabled.length,
    logicalAgents,
    departmentPools: physical.pools,
    physicalAgents: physical.physicalAgents,
    writerConcurrency: physical.writerConcurrency,
    dailyBudgetUsd: physical.dailyBudgetUsd,
    strategy: 'isolated_worktrees_serialized_merge',
  };
}

async function syncPoolForDepartment({ prisma, project, departments, requestedId, payload }) {
  const normalizedId = slug(requestedId);
  const row = departments.find((department) => (
    department.id === normalizedId
    || department.id === `custom-${normalizedId}`
    || department.name.toLowerCase() === boundedText(payload?.name, 90).toLowerCase()
  ));
  if (!row) return null;
  return departmentPools.upsertDepartmentPool({
    prisma,
    project,
    departmentId: row.id,
    size: payload?.poolSize ?? row.desiredAgents,
    dailyBudgetUsd: Object.prototype.hasOwnProperty.call(asRecord(payload), 'dailyBudgetUsd')
      ? payload.dailyBudgetUsd
      : undefined,
    enabled: row.enabled !== false,
  });
}

async function writeDepartments({ prisma, project, departments }) {
  if (!prisma?.codexProject?.update || !project?.id) return [];
  const custom = normalizeCustomDepartments(departments);
  let source = project;
  let nextBrief = coerceBriefRecord(project.brief);
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief, fresh) => {
      source = fresh;
      nextBrief = { ...brief, companyDepartments: custom };
      return nextBrief;
    },
  });
  return readDepartments({ ...source, brief: nextBrief });
}

async function mutateDepartmentMeta({ prisma, project, mutate }) {
  if (!prisma?.codexProject?.update || !project?.id) return readDepartments(project);
  let source = project;
  let nextBrief = coerceBriefRecord(project.brief);
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief, fresh) => {
      source = fresh;
      nextBrief = mutate({ ...brief });
      return nextBrief;
    },
  });
  return readDepartments({ ...source, brief: nextBrief });
}

async function upsertDepartment({ prisma, project, department }) {
  const fresh = prisma?.codexProject?.findUnique
    ? await prisma.codexProject.findUnique({ where: { id: project.id } }).catch(() => null)
    : null;
  const source = fresh || project;
  const builtInIds = new Set(BUILT_IN_DEPARTMENTS.map((item) => item.id));
  const payload = asRecord(department);
  const requestedId = slug(payload.id || payload.name || '');
  const isBuiltInUpdate = Boolean(requestedId && builtInIds.has(requestedId) && payload.custom !== true);

  if (isBuiltInUpdate) {
    const base = BUILT_IN_DEPARTMENTS.find((item) => item.id === requestedId);
    const name = boundedText(payload.name, 90) || base?.name || '';
    if (!name) throw new Error('department_name_required');
    const rows = await mutateDepartmentMeta({
      prisma,
      project: source,
      mutate: (brief) => {
        const overrides = normalizeOverrides(brief.companyDepartmentOverrides);
        const hidden = normalizeHidden(brief.companyDepartmentHidden).filter((id) => id !== requestedId);
        const previous = asRecord(overrides[requestedId]);
        overrides[requestedId] = {
          ...previous,
          name,
          mission: boundedText(payload.mission, 800) || previous.mission || base.mission,
          description: boundedText(payload.description, 240) || previous.description || base.description,
          kind: ['coordination', 'engineering', 'research', 'external'].includes(payload.kind)
            ? payload.kind
            : (previous.kind || base.kind),
          desiredAgents: payload.desiredAgents != null
            ? boundedAgents(payload.desiredAgents, base.desiredAgents)
            : (previous.desiredAgents || base.desiredAgents),
          keywords: Array.isArray(payload.keywords)
            ? [...new Set(payload.keywords.map((item) => boundedText(item, 60).toLowerCase()).filter(Boolean))].slice(0, 20)
            : (previous.keywords || base.keywords),
        };
        return {
          ...brief,
          companyDepartmentOverrides: overrides,
          companyDepartmentHidden: hidden,
        };
      },
    });
    await syncPoolForDepartment({
      prisma,
      project: source,
      departments: rows,
      requestedId,
      payload,
    });
    return rows;
  }

  const current = normalizeCustomDepartments(coerceBriefRecord(source.brief).companyDepartments);
  const normalized = normalizeDepartment(department, { custom: true, index: current.length });
  if (!normalized) throw new Error('department_name_required');
  const next = [
    ...current.filter((item) => item.id !== normalized.id && item.name.toLowerCase() !== normalized.name.toLowerCase()),
    normalized,
  ];
  const rows = await writeDepartments({ prisma, project: source, departments: next });
  await syncPoolForDepartment({
    prisma,
    project: source,
    departments: rows,
    requestedId: normalized.id,
    payload,
  });
  return rows;
}

async function deleteDepartment({ prisma, project, departmentId }) {
  const fresh = prisma?.codexProject?.findUnique
    ? await prisma.codexProject.findUnique({ where: { id: project.id } }).catch(() => null)
    : null;
  const source = fresh || project;
  const id = slug(departmentId);
  if (!id) throw new Error('department_not_found');
  if (id === 'ceo-office') throw new Error('cannot_delete_ceo_office');

  const builtInIds = new Set(BUILT_IN_DEPARTMENTS.map((item) => item.id));
  if (builtInIds.has(id)) {
    const rows = await mutateDepartmentMeta({
      prisma,
      project: source,
      mutate: (brief) => {
        const hidden = new Set(normalizeHidden(brief.companyDepartmentHidden));
        hidden.add(id);
        const overrides = normalizeOverrides(brief.companyDepartmentOverrides);
        delete overrides[id];
        return {
          ...brief,
          companyDepartmentHidden: [...hidden],
          companyDepartmentOverrides: overrides,
        };
      },
    });
    await departmentPools.removeDepartmentPool({ prisma, project: source, departmentId: id });
    return rows;
  }

  const current = normalizeCustomDepartments(coerceBriefRecord(source.brief).companyDepartments);
  if (!current.some((item) => item.id === id)) throw new Error('department_not_found');
  const next = current.filter((item) => item.id !== id);
  const rows = await writeDepartments({ prisma, project: source, departments: next });
  await departmentPools.removeDepartmentPool({ prisma, project: source, departmentId: id });
  return rows;
}

module.exports = {
  BUILT_IN_DEPARTMENTS,
  MAX_AGENTS_PER_DEPARTMENT,
  MAX_CUSTOM_DEPARTMENTS,
  boundedAgents,
  capacitySummary,
  deleteDepartment,
  normalizeCustomDepartments,
  normalizeDepartment,
  readDepartments,
  upsertDepartment,
  writeDepartments,
};
