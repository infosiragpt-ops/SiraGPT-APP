---
name: OpenClaw agentic integration state
description: OpenClaw agentic tools/skills are already fully integrated and live in SiraGPT — do not re-port
---

# OpenClaw agentic functionality is already integrated

A recurring user ask is "bring the agentic functionality / tools / skills from
OpenClaw into SiraGPT." This is **already done** and validated. Do NOT re-port or
copy OpenClaw code — it would duplicate and risk breaking a more complete system.

Evidence (re-verify with these, don't trust this note blindly):
- Integration map (`npm run agent:openclaw:map -- --json`) reports every upstream
  capability `status: "covered"`.
- Skill registry (`npm run skill:validate:agents`) → `"issues": []`.
- Core agentic + openclaw test suite passes (agentic-chat-stream, agentic-operating-core,
  enterprise-agentic-runtime, agent-tools, agent-skill-registry, mcp-tool-registry,
  openclaw-playbook-bridge/source-inventory/capability-kernel/finalize-guard).

Runtime reality:
- The agentic chat loop lives in `backend/src/services/agentic-chat-stream.js` and is
  invoked from `backend/src/routes/ai.js`.
- `isEnabled()` **defaults to true** (only `SIRAGPT_AGENTIC_CHAT_ENABLED` /
  `AGENTIC_TOOLS_IN_CHAT` set to 0/false/off/no disables it) — so it is ON by default.
- `buildDefaultTools()` already wires a broad REAL toolset: web_search, read_url,
  memoryRecall, ragRetrieve, selfRagAnswer, docintel analyze/retrieve/tables/compare,
  deepAnalyze, autoFile, compareDocuments, pythonExec, bashExec, createDocument,
  verifyArtifact, runTests, cloneProject, hostBash, hostFile, CI status/monitor, plus
  visual+audio media tools when the turn wants media.

**Governance:** OpenClaw upstream is reference-only under `.agents/openclaw-upstream`
(MIT, attributed). Per the `openclaw-import-audit` skill, adapt ideas into SiraGPT-owned
services/skills — never activate upstream code directly, and keep UI locked.

**How to apply:** if a user asks to "integrate OpenClaw agentic," first run the map +
skill validate + test suite to show it's covered, then ask which SPECIFIC capability they
believe is missing rather than bulk-porting.
