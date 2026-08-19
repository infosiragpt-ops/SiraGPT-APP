'use strict';

/**
 * Enhanced multi-agent team orchestrator.
 *
 * Dispatches specialised sub-agents for complex tasks:
 * - thesis-writer + apa-reviewer + citation-verifier (academic)
 * - planner + coder + reviewer + security-auditor (code)
 * - researcher + critic + synthesizer (general)
 *
 * Agents communicate via a shared state object and can be
 * chained, forked, or voted on results.
 */

const { selectTeam } = require('./team-router');

const AGENT_REGISTRY = Object.freeze({
  'thesis-writer': {
    role: 'Thesis Writer',
    capabilities: ['academic_writing', 'research', 'structuring'],
    prompt: 'You are a thesis writing specialist. Produce well-structured academic content with proper argumentation.',
  },
  'apa-reviewer': {
    role: 'APA Reviewer',
    capabilities: ['citation_checking', 'formatting', 'style_guide'],
    prompt: 'You are an APA 7th edition reviewer. Check citations, references, and formatting for APA compliance.',
  },
  'citation-verifier': {
    role: 'Citation Verifier',
    capabilities: ['crossref', 'doi_verification', 'bibliography'],
    prompt: 'You verify academic citations against known databases. Flag suspicious or incomplete references.',
  },
  planner: {
    role: 'Task Planner',
    capabilities: ['planning', 'decomposition', 'estimation'],
    prompt: 'You decompose complex tasks into actionable steps. Output a structured plan.',
  },
  coder: {
    role: 'Code Generator',
    capabilities: ['code_generation', 'refactoring', 'debugging'],
    prompt: 'You generate clean, well-documented, production-quality code following best practices.',
  },
  reviewer: {
    role: 'Code Reviewer',
    capabilities: ['code_review', 'security_analysis', 'best_practices'],
    prompt: 'You review code for correctness, security, performance, and maintainability.',
  },
  'security-auditor': {
    role: 'Security Auditor',
    capabilities: ['vulnerability_scanning', 'owasp', 'compliance'],
    prompt: 'You audit code and configurations for security vulnerabilities. Flag OWASP Top 10 issues.',
  },
  critic: {
    role: 'Output Critic',
    capabilities: ['quality_assessment', 'coherence_check', 'safety_filter'],
    prompt: 'You critically evaluate outputs for quality, coherence, and safety. Suggest improvements.',
  },
  synthesizer: {
    role: 'Content Synthesizer',
    capabilities: ['summarization', 'integration', 'narrative'],
    prompt: 'You synthesize multiple inputs into a coherent, well-structured final output.',
  },
  finalizer: {
    role: 'Output Finalizer',
    capabilities: ['formatting', 'polishing', 'delivery'],
    prompt: 'You polish and format the final output for delivery to the user.',
  },
});

const WORKFLOWS = Object.freeze({
  thesis: {
    name: 'Thesis Workflow',
    agents: ['thesis-writer', 'apa-reviewer', 'citation-verifier'],
    mode: 'chain',
    description: 'Writer → Reviewer → Verifier chain for academic content',
  },
  code: {
    name: 'Code Workflow',
    agents: ['planner', 'coder', 'reviewer'],
    mode: 'chain',
    description: 'Plan → Code → Review pipeline',
  },
  'code-secure': {
    name: 'Code with Security Audit',
    agents: ['planner', 'coder', 'reviewer', 'security-auditor'],
    mode: 'chain',
    description: 'Plan → Code → Review → Security Audit',
  },
  research: {
    name: 'Research Workflow',
    agents: ['researcher', 'critic', 'synthesizer', 'finalizer'],
    mode: 'chain',
    description: 'Research → Critique → Synthesize → Finalize',
  },
  general: {
    name: 'General Workflow',
    agents: ['planner', 'critic', 'finalizer'],
    mode: 'chain',
    description: 'Simple plan → critique → finalize pipeline',
  },
  'fork-join': {
    name: 'Fork-Join Analysis',
    agents: ['planner', 'coder', 'critic'],
    mode: 'fork-join',
    description: 'Fork to multiple analysts, join results',
  },
  vote: {
    name: 'Voting Ensemble',
    agents: ['planner', 'reviewer', 'critic'],
    mode: 'vote',
    description: 'Multiple agents vote on the best response',
  },
});

function resolveWorkflow(intent = '', gateways = {}) {
  const text = String(intent).toLowerCase();
  if (/\btesis|apa|paper|investigaci[oó]n|bibliograf/i.test(text)) {
    return WORKFLOWS.thesis;
  }
  if (/\bsecurity|vulnerab|audit|owasp|pentest/i.test(text)) {
    return WORKFLOWS['code-secure'];
  }
  if (/\bcode|debug|refactor|repo|programa/i.test(text)) {
    return WORKFLOWS.code;
  }
  if (/\bresearch|investig|deep.*search/i.test(text)) {
    return WORKFLOWS.research;
  }
  if (/\bmult.*(view|perspective|angle|opinion)/i.test(text)) {
    return WORKFLOWS['fork-join'];
  }
  return WORKFLOWS.general;
}

function createMultiAgentOrchestrator({ gateway, maxParallel = 3 } = {}) {
  async function executeChain(workflow, state) {
    const results = [];
    let currentState = { ...state };
    for (const agentName of workflow.agents) {
      const agent = AGENT_REGISTRY[agentName];
      if (!agent || !gateway) continue;
      try {
        const taskMessages = [
          { role: 'system', content: agent.prompt },
          { role: 'user', content: JSON.stringify({ task: state.prompt, context: state.context, previousResults: results }) },
        ];
        const result = await gateway.complete({ messages: taskMessages, prompt: state.prompt });
        const output = result.response?.choices?.[0]?.message?.content || '';
        results.push({ agent: agentName, role: agent.role, output });
        currentState.context = output;
      } catch (err) {
        results.push({ agent: agentName, error: err.message });
      }
    }
    return { workflow: workflow.name, mode: 'chain', results };
  }

  async function executeForkJoin(workflow, state) {
    const tasks = workflow.agents
      .filter(name => AGENT_REGISTRY[name] && gateway)
      .slice(0, maxParallel)
      .map(async (agentName) => {
        const agent = AGENT_REGISTRY[agentName];
        try {
          const result = await gateway.complete({
            messages: [
              { role: 'system', content: agent.prompt },
              { role: 'user', content: state.prompt },
            ],
            prompt: state.prompt,
          });
          return { agent: agentName, output: result.response?.choices?.[0]?.message?.content || '' };
        } catch (err) {
          return { agent: agentName, error: err.message };
        }
      });
    const results = await Promise.all(tasks);
    return { workflow: workflow.name, mode: 'fork-join', results };
  }

  async function executeVote(workflow, state) {
    const forkResult = await executeForkJoin(workflow, state);
    const validOutputs = forkResult.results.filter(r => r.output);
    if (validOutputs.length === 0) return forkResult;

    const bestIdx = validOutputs.reduce((best, curr, idx) => {
      const currScore = (curr.output?.length || 0) * 0.4 + (curr.output?.split('\n').length || 0) * 0.3 + (curr.output?.match(/\w+/g)?.length || 0) * 0.3;
      const bestScore = (validOutputs[best]?.output?.length || 0) * 0.4 + (validOutputs[best]?.output?.split('\n').length || 0) * 0.3 + (validOutputs[best]?.output?.match(/\w+/g)?.length || 0) * 0.3;
      return currScore > bestScore ? idx : best;
    }, 0);

    return { workflow: workflow.name, mode: 'vote', selected: validOutputs[bestIdx], results: forkResult.results };
  }

  return {
    AGENT_REGISTRY,
    WORKFLOWS,
    resolveWorkflow,
    selectTeam,
    async run({ intent = '', prompt = '', context = {}, mode } = {}) {
      const workflow = resolveWorkflow(intent);
      if (mode) workflow.mode = mode;
      const state = { prompt, context, intent };

      switch (workflow.mode) {
        case 'chain': return executeChain(workflow, state);
        case 'fork-join': return executeForkJoin(workflow, state);
        case 'vote': return executeVote(workflow, state);
        default: return executeChain(workflow, state);
      }
    },
  };
}

module.exports = { createMultiAgentOrchestrator, AGENT_REGISTRY, WORKFLOWS, resolveWorkflow };
