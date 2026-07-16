'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/services/agents/custom-gpt-agent-policy');

describe('custom GPT agent policy', () => {
  test('federated scientific search is preferred while OpenAlex remains available', () => {
    const recommendations = policy.inferRecommendedSkills('Busca artículos científicos recientes sobre diabetes');
    assert.deepEqual(recommendations.slice(0, 2), ['scientific_federated_search', 'openalex_search']);
  });
  test('routes non-trivial turns in auto mode and recommends academic skills', () => {
    const resolved = policy.resolveCustomGptAgentPolicy({
      prompt: 'Busca artículos científicos recientes, verifica sus DOI y formatea las referencias en APA 7',
      capabilities: {
        agentMode: 'auto',
        skillsEnabled: true,
        skillIds: ['openalex_search', 'crossref_verify', 'apa7_format', 'cron_schedule'],
      },
      semanticSkillIds: ['academic_report'],
    });

    assert.equal(resolved.routeNonTrivial, true);
    assert.equal(resolved.requiresSkill, true);
    assert.deepEqual(resolved.recommendedSkillIds, ['openalex_search', 'crossref_verify', 'apa7_format']);
    assert.ok(!resolved.recommendedSkillIds.includes('cron_schedule'));
  });

  test('does not require a skill when the turn has no specialized need', () => {
    const resolved = policy.resolveCustomGptAgentPolicy({
      prompt: 'Ayúdame a mejorar la claridad de este párrafo',
      capabilities: { agentMode: 'auto', skillsEnabled: true, skillIds: ['apa7_format'] },
    });
    assert.equal(resolved.routeNonTrivial, true);
    assert.equal(resolved.requiresSkill, false);
    assert.deepEqual(resolved.recommendedSkillIds, []);
  });

  test('preserves hidden agent settings when legacy capability toggles are updated', () => {
    const merged = policy.mergeCustomGptCapabilities(
      {
        webBrowsing: true,
        agentMode: 'auto',
        skillsEnabled: true,
        skillIds: ['openalex_search', 'crossref_verify'],
        multipleArtifacts: true,
        maxArtifactsPerTurn: 6,
      },
      { webBrowsing: false, dataAnalysis: true, imageGeneration: true, codeInterpreter: false },
    );

    assert.equal(merged.webBrowsing, false);
    assert.equal(merged.agentMode, 'auto');
    assert.equal(merged.skillsEnabled, true);
    assert.deepEqual(merged.skillIds, ['openalex_search', 'crossref_verify']);
    assert.equal(merged.multipleArtifacts, true);
    assert.equal(merged.maxArtifactsPerTurn, 6);
  });

  test('maps plans and admin flags to skill clearance', () => {
    assert.equal(policy.resolveUserSkillClearance({ id: 'u1', plan: 'FREE' }), 'authenticated');
    assert.equal(policy.resolveUserSkillClearance({ id: 'u1', plan: 'PRO_MAX' }), 'paid');
    assert.equal(policy.resolveUserSkillClearance({ id: 'u1', plan: 'FREE', isSuperAdmin: true }), 'enterprise');
  });

  test('skill execution prompt advertises pipeline usage for deterministic chains', () => {
    const prompt = policy.buildSkillExecutionPrompt({
      skillsEnabled: true,
      allowedSkillIds: ['openalex_search', 'crossref_verify', 'apa7_format'],
      recommendedSkillIds: ['openalex_search', 'crossref_verify'],
      requiresSkill: true,
    });
    assert.match(prompt, /run_skill_pipeline/);
    assert.match(prompt, /2 a 6 skills/);
    assert.match(prompt, /buscar -> verificar -> formatear/);
  });
});
