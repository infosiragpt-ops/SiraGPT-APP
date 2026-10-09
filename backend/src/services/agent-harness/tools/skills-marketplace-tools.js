'use strict';

/**
 * Skills marketplace tools — the chat agent discovers and installs Agent
 * Skills from ClawHub (https://clawhub.ai), a GitHub repo or a SKILL.md URL
 * into the user's Biblioteca (Ajustes → Skills → Tuyos). Native rewrite of
 * the OpenClaw (MIT) `clawhub` skill flow (search → verify → install); the
 * work happens in services/skills-import with the web_fetch SSRF posture.
 *
 *   search_skills_marketplace — read-only → 'auto'
 *   install_skill             — writes the user's library → 'confirm'
 *
 * `ctx.skillsImport` is injectable for offline tests.
 */

const { z } = require('zod');

const searchSchema = z.object({
  query: z.string().min(1).max(200).describe('What the user needs, in a few words (e.g. "postgres backups", "notion", "resumir pdf").'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results (default 8).'),
}).strict();

const installSchema = z.object({
  source: z.string().min(1).max(500)
    .describe('Where the skill lives: a ClawHub slug or "clawhub:<slug>" (from search results), "owner/repo[/path][@ref]" or a github.com URL, or the https URL of a SKILL.md / .zip package.'),
  name: z.string().min(1).max(64).optional()
    .describe('Override the saved name (kebab-case). Omit to keep the skill\'s own name.'),
  overwrite: z.boolean().optional()
    .describe('true only when the user agreed to replace a skill they already have with that name.'),
}).strict();

function fmtResult(r, i) {
  const bits = [`${i + 1}. ${r.name} (${r.installRef})`];
  if (r.summary) bits.push(`— ${r.summary}`);
  const tags = [r.official ? 'oficial' : null, r.publisher ? `por ${r.publisher}` : null, Number.isFinite(r.installs) ? `${r.installs} instalaciones` : null].filter(Boolean);
  if (tags.length) bits.push(`[${tags.join(' · ')}]`);
  return bits.join(' ');
}

function buildSearchSkillsMarketplaceTool() {
  return {
    name: 'search_skills_marketplace',
    description: [
      'Search the public Agent Skills marketplace (ClawHub) for skills the user could install: playbooks for tools, workflows and integrations shared by the community.',
      'WHEN TO USE: the user asks whether a skill exists for something, wants to browse or add skills from the marketplace/ClawHub, or asks for a capability the built-in skills and their own library do not cover (check use_skill first).',
      'WHEN NOT TO USE: the skill is already in the user\'s library (use_skill), or the user wants to write their own (save_skill). Searching never installs anything.',
      'Relay the results with their installRef so the user can pick one; install only when they ask.',
    ].join(' '),
    inputSchema: searchSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Buscando skills en el marketplace: ${String(args.query || '').slice(0, 60)}`,
    execute: async (args = {}, ctx = {}) => {
      const skillsImport = ctx.skillsImport || require('../../skills-import');
      try {
        const out = await skillsImport.searchMarketplace(args.query, { limit: args.limit || 8 });
        if (!out.results.length) {
          return { ok: true, count: 0, results: [], summary: `No encontré skills para «${String(args.query).slice(0, 80)}» en el marketplace.` };
        }
        return {
          ok: true,
          count: out.results.length,
          results: out.results,
          summary: `Skills en el marketplace para «${String(args.query).slice(0, 80)}»:\n${out.results.map(fmtResult).join('\n')}\nPara instalar una: install_skill({ source: "<installRef>" }) (pide confirmación al usuario).`,
        };
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'marketplace_error', error: (err && err.message) || 'El marketplace no respondió.' };
      }
    },
  };
}

function buildInstallSkillTool() {
  return {
    name: 'install_skill',
    description: [
      'Install an Agent Skill into the user\'s library from the marketplace (ClawHub slug), a GitHub repository or a SKILL.md / .zip URL. ClawHub skills are checked against the marketplace security verdict before installing; blocked skills are refused.',
      'WHEN TO USE: the user picked a skill from search_skills_marketplace results, or pasted a ClawHub / GitHub / SKILL.md link and asked to add or install it.',
      'WHEN NOT TO USE: without the user asking to install; to save a skill written in this chat (save_skill); for built-in skills (already available).',
      'Each call asks the user to confirm. Afterwards the skill is available with use_skill, in «+ → Skills» and with «/».',
    ].join(' '),
    inputSchema: installSchema,
    permissionTier: 'confirm',
    humanDescription: (args = {}) => `Instalar la skill «${String(args.source || '').slice(0, 80)}» en tus skills`,
    execute: async (args = {}, ctx = {}) => {
      const userId = ctx.userId || null;
      if (!userId) return { ok: false, code: 'auth_required', error: 'Inicia sesión para instalar skills.' };
      const skillsImport = ctx.skillsImport || require('../../skills-import');
      try {
        const out = await skillsImport.importSkill({ userId, source: args.source, name: args.name || null, overwrite: Boolean(args.overwrite) });
        const name = out.skill && out.skill.name;
        const origin = out.provenance.source === 'clawhub' ? 'ClawHub' : (out.provenance.source === 'github' ? 'GitHub' : 'la URL indicada');
        return {
          ok: true,
          name,
          installed: true,
          replaced: out.replaced,
          renamed: out.renamed,
          provenance: out.provenance,
          summary: `Skill «${name}» instalada desde ${origin}${out.provenance.version ? ` (versión ${out.provenance.version})` : ''}${out.renamed ? ` — se guardó como «${name}» porque «${out.renamed}» es una skill integrada` : ''}. Ya aparece en Ajustes → Skills, en «+ → Skills» y con «/»; puedo cargarla ahora con use_skill.`,
        };
      } catch (err) {
        return {
          ok: false,
          code: (err && err.code) || 'skill_install_failed',
          error: (err && err.message) || 'No se pudo instalar la skill.',
          ...(err && err.details ? { details: err.details } : {}),
          hint: 'Transmite el error al usuario tal cual. Si es name_taken, pregúntale si quiere reemplazar la suya (overwrite: true) o usar otro nombre.',
        };
      }
    },
  };
}

module.exports = { buildSearchSkillsMarketplaceTool, buildInstallSkillTool };
