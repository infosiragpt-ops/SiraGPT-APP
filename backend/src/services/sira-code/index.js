'use strict';

/**
 * SiraCode — native coding-agent core for SiraGPT.
 *
 * Independent rewrite inspired by anomalyco/opencode (MIT). Not a vendor
 * copy and not affiliated with OpenCode or Anomaly. See NOTICE / THIRD_PARTY_NOTICES.md.
 */

const agents = require('./agents');
const permissions = require('./permissions');
const display = require('./display');
const workspace = require('./workspace');
const tools = require('./tools');
const events = require('./events');
const store = require('./session-store');
const loop = require('./loop');
const engine = require('./engine');
const planHandoff = require('./plan-handoff');
const permissionResume = require('./permission-resume');
const sessionTitle = require('./session-title');
const toolResult = require('./tool-result');
const sessionSummary = require('./session-summary');
const toolRounds = require('./tool-rounds');
const search = require('./search');
const shellSandbox = require('./shell-sandbox');
const fileTools = require('./file-tools');
const diagnostics = require('./diagnostics');
const questionTool = require('./question-tool');
const taskSpawn = require('./task-spawn');
const isolatedPreview = require('./isolated-preview');

module.exports = {
  ...agents,
  ...permissions,
  ...display,
  ...workspace,
  ...tools,
  ...events,
  ...store,
  ...loop,
  ...engine,
  ...planHandoff,
  ...permissionResume,
  ...sessionTitle,
  ...toolResult,
  ...sessionSummary,
  ...toolRounds,
  ...search,
  ...shellSandbox,
  runRead: fileTools.runRead,
  runWrite: fileTools.runWrite,
  runEdit: fileTools.runEdit,
  runMultiedit: fileTools.runMultiedit,
  replaceUnique: fileTools.replaceUnique,
  FILE_TOOL_ERRORS: fileTools.ERRORS,
  runDiagnostics: diagnostics.runDiagnostics,
  prettyDiagnostic: diagnostics.pretty,
  reportDiagnosticsFile: diagnostics.reportFile,
  DIAGNOSTIC_ERRORS: diagnostics.ERRORS,
  isQuestionTool: questionTool.isQuestionTool,
  normalizeQuestionArgs: questionTool.normalizeQuestionArgs,
  validateAnswers: questionTool.validateAnswers,
  publicQuestions: questionTool.publicQuestions,
  runQuestion: questionTool.runQuestion,
  QUESTION_ERRORS: questionTool.ERRORS,
  runTask: taskSpawn.runTask,
  resolveSubagentType: taskSpawn.resolveSubagentType,
  TASK_SPAWN_ERRORS: taskSpawn.ERRORS,
  startIsolatedPreview: isolatedPreview.startIsolatedPreview,
  proveWorkspace: isolatedPreview.proveWorkspace,
  attachProof: isolatedPreview.attachProof,
  stopPreview: isolatedPreview.stopPreview,
};
