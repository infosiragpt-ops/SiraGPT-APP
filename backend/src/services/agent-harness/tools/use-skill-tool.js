'use strict';

/**
 * use_skill — the chat agent loads an Agent Skill on demand (claude.ai style
 * progressive disclosure): without a name it returns the catalog (built-in
 * document skills + the user's Biblioteca), with a name it returns that
 * skill's full instructions for the model to follow. Read-only → 'auto'.
 *
 * `ctx.chatSkills` is injectable for offline tests.
 */

const { z } = require('zod');

const inputSchema = z.object({
  name: z.string().max(64).optional()
    .describe('Skill to load (e.g. "docx", "pptx", "xlsx", "pdf", "csv", or one from the user Biblioteca). Omit to list every available skill.'),
}).strict();

function buildUseSkillTool() {
  return {
    name: 'use_skill',
    description: [
      'Load an Agent Skill: a playbook with the exact procedure and quality bar for a kind of task.',
      'Built-in skills: docx (Word), pptx (PowerPoint), xlsx (Excel), pdf, csv; the user may also have their own skills and skills installed from the SiraGPT catalog (Ajustes → Skills).',
      'WHEN TO USE: before creating or editing a Word/PowerPoint/Excel/PDF/CSV file, or when the task matches a skill the user saved. Call without "name" to see the catalog, then load the one that fits and follow it.',
      'WHEN NOT TO USE: small talk or questions answerable directly; a skill already active in the system prompt this turn.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => (args && args.name ? `Cargando la skill ${String(args.name).slice(0, 40)}` : 'Consultando las skills disponibles'),
    execute: async (args = {}, ctx = {}) => {
      const chatSkills = ctx.chatSkills || require('../../chat-skills');
      const userId = ctx.userId || null;
      const wanted = args && args.name ? String(args.name) : '';
      if (!wanted.trim()) {
        const catalog = chatSkills.listChatSkills({ userId });
        return {
          ok: true,
          count: catalog.length,
          catalog: chatSkills.formatSkillsCatalog(catalog),
          hint: 'Carga la skill que corresponda con use_skill({ name }) y sigue sus instrucciones.',
        };
      }
      const skill = chatSkills.loadChatSkill({ userId, name: wanted, respectDisabled: true });
      if (!skill) {
        const catalog = chatSkills.listChatSkills({ userId });
        return {
          ok: false,
          error: `No existe la skill «${wanted.slice(0, 64)}».`,
          catalog: chatSkills.formatSkillsCatalog(catalog),
        };
      }
      return {
        ok: true,
        name: skill.name,
        title: skill.title,
        source: skill.source,
        instructions: skill.body.slice(0, chatSkills.MAX_SKILL_PROMPT_CHARS),
      };
    },
  };
}

module.exports = { buildUseSkillTool };
