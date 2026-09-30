'use strict';

/**
 * save_skill — the chat agent saves a new Agent Skill in the user's library
 * («Tuyos» in Ajustes → Skills), claude.ai «skill-creator» style. The skill
 * then shows in «+ → Skills», with «/» and to use_skill in later turns: the
 * agent's procedural memory, like the facts it keeps with memory_write.
 *
 * Writes persistent user state, so every call asks the user to confirm.
 * `ctx.chatSkills` is injectable for offline tests.
 */

const { z } = require('zod');

const inputSchema = z.object({
  name: z.string().min(1).max(64)
    .describe('kebab-case id: lowercase letters, digits, "-" or "_" (e.g. "informe-semanal").'),
  description: z.string().min(1).max(160)
    .describe('One sentence: what the skill does AND when to use it.'),
  body: z.string().min(1).max(16000)
    .describe('Markdown instructions: purpose, when to use, numbered procedure, output format, quality checklist.'),
  overwrite: z.boolean().optional()
    .describe('true only to replace a skill the user already created with the same name.'),
}).strict();

function buildSaveSkillTool() {
  return {
    name: 'save_skill',
    description: [
      "Save a new Agent Skill in the user's library so it can be reused later (Ajustes → Skills → Tuyos, «+ → Skills» and «/»).",
      'WHEN TO USE: after drafting a skill with the user (skill-creator) and the user approved the final version, or when the user explicitly asks to turn a repeatable procedure into a skill.',
      'WHEN NOT TO USE: to store facts about the user (use memory_write), without the user approving the draft, or to modify built-in skills.',
      'Each call asks the user to confirm before saving.',
    ].join(' '),
    inputSchema,
    permissionTier: 'confirm',
    humanDescription: (args = {}) => `Guardar la skill «${String(args.name || '').slice(0, 64)}» en tus skills`,
    execute: async (args = {}, ctx = {}) => {
      const userId = ctx.userId || null;
      if (!userId) return { ok: false, error: 'Inicia sesión para guardar skills.' };
      const chatSkills = ctx.chatSkills || require('../../chat-skills');
      const save = args.overwrite ? chatSkills.updateUserSkill : chatSkills.createUserSkill;
      try {
        const skill = save({ userId, name: args.name, description: args.description, body: args.body });
        return {
          ok: true,
          name: skill && skill.name,
          saved: true,
          message: `La skill «${skill && skill.name}» quedó guardada en Ajustes → Skills y ya aparece en «+ → Skills» y con «/».`,
        };
      } catch (err) {
        return { ok: false, error: (err && err.message) || 'No se pudo guardar la skill.', code: err && err.code };
      }
    },
  };
}

module.exports = { buildSaveSkillTool };
