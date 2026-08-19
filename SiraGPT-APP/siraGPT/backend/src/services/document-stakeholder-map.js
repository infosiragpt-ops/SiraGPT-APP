'use strict';

/**
 * document-stakeholder-map.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects role-based stakeholders mentioned in attached documents and
 * builds a role → mention-count map per file. Different from the
 * semantic-graph (which works on proper-noun entities like company
 * names): this module focuses on STAKEHOLDER ROLES that drive
 * decisions and obligations — CEO, board, customer, vendor, auditor,
 * regulator, etc.
 *
 * Bilingual. Deterministic. < 15 ms on 1 MB.
 *
 * Stakeholder taxonomy (≈ 35 roles, EN + ES):
 *   - leadership      CEO, CFO, COO, CTO, CIO, board, directors,
 *                     trustees, leadership, presidente, gerencia
 *   - operations      operator, vendor, supplier, contractor, agent,
 *                     proveedor, contratista, operador
 *   - customer        customer, client, user, end-user, subscriber,
 *                     cliente, usuario, suscriptor
 *   - partner         partner, ally, joint venture, JV, distribuidor
 *   - investor        investor, shareholder, stakeholder, accionista
 *   - regulator       regulator, auditor, inspector, regulador
 *   - workforce       employee, staff, contractor, empleado, personal
 *   - legal           counsel, attorney, lawyer, court, abogado, juez
 *
 * Public API:
 *   buildStakeholderMapForFiles(files)  → { perFile, aggregate }
 *   renderStakeholderBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_ROLES_PER_FILE = 12;
const MAX_BLOCK_CHARS = 3600;

const ROLE_GROUPS = [
  {
    group: 'leadership',
    patterns: [
      /\b(CEO|CFO|COO|CTO|CIO|CMO|chief\s+(?:executive|financial|operating|technology|information|marketing)\s+officer|board\s+of\s+directors|board\s+members?|board|directors?|trustees?|leadership\s+team)\b/i,
      /\b(presidente|director\s+general|gerencia|gerente\s+general|consejo\s+(?:de\s+)?(?:administraci[oó]n|directivo)|directores?|fideicomisarios?)\b/i,
    ],
  },
  {
    group: 'operations',
    patterns: [
      /\b(operators?|vendors?|suppliers?|contractors?|sub[- ]?contractors?|agents?|operating\s+entity)\b/i,
      /\b(operadores?|proveedores?|contratistas?|subcontratistas?|agentes?|operador)\b/i,
    ],
  },
  {
    group: 'customer',
    patterns: [
      /\b(customers?|clients?|end[- ]?users?|users?|subscribers?|members?)\b/i,
      /\b(clientes?|usuarios?|suscriptores?|miembros?|consumidores?)\b/i,
    ],
  },
  {
    group: 'partner',
    patterns: [
      /\b(partners?|alliance|joint\s+venture|JV|distributors?|resellers?|integrators?)\b/i,
      /\b(socios?|alianza|empresa\s+conjunta|distribuidor(?:es)?|revendedor(?:es)?|integrador(?:es)?)\b/i,
    ],
  },
  {
    group: 'investor',
    patterns: [
      /\b(investors?|shareholders?|stakeholders?|venture\s+capital|VC|limited\s+partners?|LP|general\s+partners?|GP)\b/i,
      /\b(inversores?|accionistas?|interesados?|capital\s+riesgo|socios?\s+limitados?|fondo\s+de\s+inversi[oó]n)\b/i,
    ],
  },
  {
    group: 'regulator',
    patterns: [
      /\b(regulators?|auditors?|inspectors?|examiners?|supervisor(?:y\s+(?:body|authority))?|regulatory\s+authority|tax\s+authority)\b/i,
      /\b(regulador(?:es)?|auditores?|inspectores?|autoridad\s+(?:fiscal|regulatoria|tributaria)|hacienda)\b/i,
    ],
  },
  {
    group: 'workforce',
    patterns: [
      /\b(employees?|staff|workforce|personnel|team\s+members?|engineers?|developers?|analysts?)\b/i,
      /\b(empleados?|personal|colaboradores?|miembros\s+del\s+equipo|equipo|ingenieros?|desarrolladores?|analistas?)\b/i,
    ],
  },
  {
    group: 'legal',
    patterns: [
      /\b(counsel|attorneys?|lawyers?|court|judges?|arbitrators?|mediator(?:s)?|legal\s+team)\b/i,
      /\b(abogados?|consejero\s+legal|jueces?|tribunal|árbitros?|mediadores?|equipo\s+legal)\b/i,
    ],
  },
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function countAll(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let count = 0;
  for (const _ of text.matchAll(global)) count++;
  return count;
}

function buildStakeholderMapForFile(text) {
  const trimmed = safeText(text);
  if (!trimmed) return { roles: [], total: 0 };
  const head = trimmed.length > SCAN_HEAD_BYTES ? trimmed.slice(0, SCAN_HEAD_BYTES) : trimmed;
  const roles = [];
  for (const grp of ROLE_GROUPS) {
    let mentions = 0;
    for (const re of grp.patterns) mentions += countAll(head, re);
    if (mentions === 0) continue;
    roles.push({ group: grp.group, mentions });
  }
  roles.sort((a, b) => b.mentions - a.mentions);
  return {
    roles: roles.slice(0, MAX_ROLES_PER_FILE),
    total: roles.reduce((acc, r) => acc + r.mentions, 0),
  };
}

function buildStakeholderMapForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  const aggregateCounts = new Map();
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const r = buildStakeholderMapForFile(text);
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, roles: r.roles, total: r.total });
    for (const role of r.roles) {
      aggregateCounts.set(role.group, (aggregateCounts.get(role.group) || 0) + role.mentions);
    }
  }
  const aggregate = Array.from(aggregateCounts.entries())
    .map(([group, mentions]) => ({ group, mentions }))
    .sort((a, b) => b.mentions - a.mentions);
  return { perFile, aggregate };
}

function renderRoleLine(r, opts = {}) {
  const fileTag = opts.includeFile && r.file ? ` _(${r.file})_` : '';
  return `- **${r.group}**${fileTag}: ${r.mentions} mention${r.mentions === 1 ? '' : 's'}`;
}

function renderStakeholderBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## STAKEHOLDER MAP
Role-based stakeholders mentioned across the attached document(s), grouped into leadership / operations / customer / partner / investor / regulator / workforce / legal. Counts are raw mentions per role group — use them to know whose interests dominate each document before answering "who is affected?" or "who decides?" questions.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file} — ${only.total} total stakeholder mentions`);
    for (const r of only.roles) sections.push(renderRoleLine(r));
  } else {
    sections.push('### Aggregate role distribution across all files');
    for (const r of report.aggregate) sections.push(renderRoleLine(r));
    for (const file of report.perFile) {
      sections.push(`\n### File: ${file.file} — ${file.total} total`);
      for (const r of file.roles) sections.push(renderRoleLine(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...stakeholder map truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildStakeholderMapForFile,
  buildStakeholderMapForFiles,
  renderStakeholderBlock,
  _internal: {
    countAll,
    ROLE_GROUPS,
    MAX_ROLES_PER_FILE,
  },
};
