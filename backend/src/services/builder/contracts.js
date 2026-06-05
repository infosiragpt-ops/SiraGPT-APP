'use strict';

/**
 * siraGPT Builder · E1 — shared contracts.
 *
 * Single source of truth for the coverage dimensions and the two structured
 * shapes that flow through the intake: the QuestionCard (what the agent asks)
 * and the ProjectBrief (what the agent emits when ready to build).
 */

const { z } = require('zod');

const COVERAGE_DIMENSIONS = ['purpose', 'platform', 'coreFeatures', 'dataEntities', 'style', 'audience'];

const QuestionCardSchema = z.object({
  id: z.string().min(1),
  dimension: z.enum(COVERAGE_DIMENSIONS),
  prompt: z.string().min(1),
  type: z.enum(['chips', 'select', 'multiselect', 'text']),
  options: z.array(z.string()).default([]),
  allowFreeText: z.boolean().default(true),
});

const ProjectBriefSchema = z.object({
  purpose: z.string(),
  platform: z.enum(['web', 'mobile', 'landing']),
  audience: z.string(),
  coreFeatures: z.array(z.string()),
  dataEntities: z.array(z.object({ name: z.string(), fields: z.array(z.string()) })),
  style: z.object({ theme: z.string(), refs: z.array(z.string()) }),
  integrations: z.array(z.string()),
  constraints: z.string(),
  openQuestions: z.array(z.string()),
});

module.exports = { COVERAGE_DIMENSIONS, QuestionCardSchema, ProjectBriefSchema };
