'use strict';

// Source-level guards for the request-brief wiring in the chat route and the
// agentic loop (the route is a 14k-line handler; these pin the contract the
// brief relies on without booting Express).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ai = read('src/routes/ai.js');
const loop = read('src/services/agentic-chat-stream.js');

test('the route computes the brief once after the understanding phase and closes the row with it', () => {
  const start = ai.indexOf("require('../services/request-brief')");
  assert.ok(start > 0, 'request-brief required in ai.js');
  const block = ai.slice(start, start + 4000);
  assert.match(block, /needsPriorArtifactLookup\(prompt\)/);
  assert.match(block, /getLatestConversationArtifact\(prisma, \{ userId, chatId, instruction: prompt \}\)/);
  assert.match(block, /buildRequestBrief\(\{\s*prompt,\s*recentTurns: __pr3RecentTurns \|\| \[\],\s*attachments: processedFiles,\s*priorArtifact: __priorArtifact,\s*coreference: __pr3CorefResult,\s*repairDetection: __pr6RepairDetection,/);
  assert.match(block, /shouldRefineWithLlm\(__requestBrief/);
  assert.match(block, /__understandingHandle\.done\(__briefRow\.label, \{ detail: __briefRow\.detail \}\)/);
  assert.match(block, /type: 'request_brief', brief: __requestBriefPublic/);
  // Fail-open: any error settles the row and leaves the hints neutral.
  assert.match(block, /catch \(_briefErr\) \{[\s\S]*?__requestBriefHints = \{ editsPreviousAnswer: false, editsGeneratedOfficeFile: false, officeTargetFormat: null \};[\s\S]*?__understandingHandle\.done\(\)/);
  // The brief is computed BEFORE the triage so its question can win.
  assert.ok(start < ai.indexOf('intentTriageDecision = await triageIntent('));
});

test('a brief question becomes the triage ask, protected from the Jev veto, and skips the web search', () => {
  assert.match(ai, /__requestBrief\.ambiguity\.ask && __requestBrief\.ambiguity\.question\s*&& \(!intentTriageDecision \|\| intentTriageDecision\.action !== 'ask'\)/);
  assert.match(ai, /source: 'request_brief',/);
  assert.match(ai, /intentTriageDecision\.source !== 'rlcd_media' && intentTriageDecision\.source !== 'request_brief'\)/);
  assert.match(ai, /const _webSearchAllowed =[\s\S]*?&& !\(intentTriageDecision && intentTriageDecision\.action === 'ask' && intentTriageDecision\.question\);/);
});

test('the brief block is a tier-0, never-pruned system block, first after the master prompt', () => {
  assert.match(ai, /content: promptBundle\.system \+ __requestBriefBlock \+ openclawRuntimeBlock/);
  assert.match(ai, /\{ kind: 'request-brief', text: __requestBriefBlock, cacheable: false \},\s*\{ kind: 'openclaw-runtime'/);
  const kernel = read('src/services/prompt-kernel.js');
  assert.match(kernel, /const ALWAYS_KEEP = new Set\(\[[\s\S]*?'request-brief'/);
  const allocator = read('src/services/prompt-budget-allocator.js');
  assert.match(allocator, /'request-brief': 0,/);
});

test('the routing gate consumes the brief: answer edits never reach the editors, Office style edits reach the runner', () => {
  assert.match(ai, /if \(documentEditRequested && \(__requestBriefHints\.editsPreviousAnswer \|\| __requestBriefHints\.editsInlineText\)\) \{\s*documentEditRequested = false;/);
  assert.match(ai, /\|\| __requestBriefHints\.editsGeneratedOfficeFile\)\s*\) \{/);
  assert.match(ai, /if \(!createDocRequested && __requestBriefHints\.editsGeneratedOfficeFile && hasPriorArtifacts\) \{\s*createDocRequested = true;/);
  assert.match(ai, /else if \(createDocRequested && \(__requestBriefHints\.editsPreviousAnswer \|\| __requestBriefHints\.editsInlineText\) && !\(processedFiles \|\| \[\]\)\.some\(\(f\) => f && !isImageMime\(f\.mimeType \|\| f\.type\)\)\) \{\s*createDocRequested = false;/);
  // The loop receives the brief and its block.
  assert.match(ai, /requestBrief: __requestBriefPublic,\s*requestBriefBlock: __requestBriefBlock \? __requestBriefBlock\.trim\(\) : '',/);
});

test('the agentic loop honours the brief in its own runner / editor claims and prompt', () => {
  assert.match(loop, /requestBrief = null,\s*requestBriefBlock = '',\s*\} = opts \|\| \{\};/);
  assert.match(loop, /const briefTargetsPreviousAnswer = Boolean\(requestBrief && requestBrief\.target && requestBrief\.target\.kind === 'previous_answer'/);
  // Text pasted in the message after an answer is chat text: same veto.
  assert.match(loop, /\|\| Boolean\(requestBrief && requestBrief\.target && requestBrief\.target\.kind === 'none' && requestBrief\.target\.source === 'inline'/);
  assert.match(loop, /const briefTargetsGeneratedOffice = Boolean\(requestBrief && requestBrief\.target && requestBrief\.target\.kind === 'generated_artifact'/);
  assert.match(loop, /const runnerClaim = !codingWorkspace && !briefTargetsPreviousAnswer && \(shouldRunAgentRunner\(\{[\s\S]*?\}\) \|\| \(briefTargetsGeneratedOffice && prior && uploadedFileRefs\.length === 0\)\);/);
  assert.match(loop, /&& isDocumentEditRequest\(userQuery\)\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*&& !briefTargetsPreviousAnswer/);
  assert.match(loop, /customGptPersona \|\| '',\s*requestBriefBlock \|\| '',\s*pluginPromptBlock,/);
});

test('the clarify short-circuit always emits the options frame and persists the decision-panel shape', () => {
  const start = ai.indexOf("// ─── Intent Triage short-circuit");
  const block = ai.slice(start, start + 6000);
  assert.match(block, /type: 'intent\.clarify_options',\s*question: baseQuestion,\s*options: triageOptions\.map\(\(o\) => \(\{ label: o\.label \}\)\),/);
  assert.doesNotMatch(block, /if \(triageOptions\.length >= 2\) \{\s*try \{\s*res\.write/);
  assert.match(block, /origin: 'intent_triage',[\s\S]*?kind: 'clarification',\s*question: baseQuestion,\s*options: triageOptions\.map\(\(o\) => \(\{ label: o\.label \}\)\),\s*\.\.\.\(__requestBriefPublic \? \{ requestBrief: __requestBriefPublic \} : \{\}\),/);
});

test('the assistant metadata of a normal turn carries the public brief', () => {
  assert.match(ai, /const assistantMeta = \{[\s\S]*?\.\.\.\(__requestBriefPublic \? \{ requestBrief: __requestBriefPublic \} : \{\}\),\s*\};/);
});
