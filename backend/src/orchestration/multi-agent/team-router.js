'use strict';

const TEAMS = Object.freeze({
  THESIS: ['thesis-writer', 'apa-reviewer', 'citation-verifier'],
  CODE: ['planner', 'coder', 'reviewer'],
  GENERAL: ['planner', 'critic', 'finalizer'],
  REDACTION_REVIEW: ['writer', 'reviewer', 'apa-verifier'],
  DATA_ANALYSIS: ['analyst', 'visualizer', 'statistician'],
});

const FRAMEWORKS = Object.freeze({
  CREWAI: 'crewai',
  AUTOGEN: 'autogen',
  BUILTIN: 'builtin',
});

function detectFramework(env = process.env) {
  const val = String(env.SIRAGPT_MULTI_AGENT_FRAMEWORK || '').toLowerCase();
  if (val === FRAMEWORKS.CREWAI) return FRAMEWORKS.CREWAI;
  if (val === FRAMEWORKS.AUTOGEN) return FRAMEWORKS.AUTOGEN;
  return FRAMEWORKS.BUILTIN;
}

function selectTeam(intent = '', _env = process.env) {
  const text = String(intent).toLowerCase();
  if (/\btesis|apa|paper|investigaci[oó]n|bibliograf/i.test(text)) {
    return TEAMS.THESIS;
  }
  if (/\bcode|debug|refactor|repo|program[a-z]*\b/i.test(text)) {
    return TEAMS.CODE;
  }
  if (/\bredact|revis|corregir|mejorar texto|reescrib/i.test(text)) {
    return TEAMS.REDACTION_REVIEW;
  }
  if (/\ban[aá]lisis|datos|estad[ií]stica|gr[aá]fic|visualiz/i.test(text)) {
    return TEAMS.DATA_ANALYSIS;
  }
  return TEAMS.GENERAL;
}

function crewAIDescriptor(team) {
  return {
    team,
    framework: 'crewai',
    config: {
      process: 'sequential',
      verbose: false,
      memory: true,
      cache: true,
    },
  };
}

function autoGenDescriptor(team) {
  return {
    team,
    framework: 'autogen',
    config: {
      maxRound: 10,
      speakerSelectionMethod: 'auto',
      allowCodeExecution: false,
    },
  };
}

function resolveTeamPlan(intent = '', env = process.env) {
  const team = selectTeam(intent, env);
  const framework = detectFramework(env);

  if (framework === FRAMEWORKS.CREWAI) return crewAIDescriptor(team);
  if (framework === FRAMEWORKS.AUTOGEN) return autoGenDescriptor(team);

  return {
    team,
    framework: FRAMEWORKS.BUILTIN,
    config: {},
  };
}

module.exports = {
  TEAMS,
  FRAMEWORKS,
  selectTeam,
  detectFramework,
  crewAIDescriptor,
  autoGenDescriptor,
  resolveTeamPlan,
};