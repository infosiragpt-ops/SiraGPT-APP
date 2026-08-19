---
name: SiraGPT skill/tool system (which one is live)
description: How agent tools are actually registered and reach the main chat; avoids wiring into the dormant system.
---

# SiraGPT skill / tool wiring

There are TWO parallel "skill" subsystems in the repo — only one is live:

- **LIVE:** `backend/src/services/skills/registry.js` loads folders under
  `backend/src/skills/<id>/` as `manifest.json` (`id`, `name`, `version`,
  `description`, `capabilities[]`, `params` JSON Schema, optional `timeoutMs`) +
  `handler.js` (`module.exports = { execute: async (args, ctx) => any }`).
  Capabilities must be in `services/skills/capabilities.js` (`net:outbound`,
  `net:outbound:llm`, `fs:read`, `schedule`, …) or load fails loudly.
- **DORMANT:** `backend/src/skills/registry.ts` + `types.ts` expect a different
  shape (`skill.json`, `tools[]`, `scopes[]`, sandboxed `ctx.fetch`/`ctx.env`).
  Do NOT target this one — the running backend is JS via the services registry.

**Critical:** the *main chat* does NOT build its toolset from the skills
registry. The live chat path is `routes/ai.js` → `services/agentic-chat-stream.js`,
whose tools come from `buildDefaultTools()` → `baseWebTools()` (a hardcoded list
adapting `services/agents/agent-tools.js`). The registry is only consumed by
`routes/agent.js` (`buildSkillTools`, opt-in `useSkills`).

**Why:** dropping a skill folder makes it loadable by the registry, but it will
NOT appear in normal chat unless you ALSO add it to `baseWebTools()` in
agentic-chat-stream.js (react-agent tool shape: `{name, description, parameters,
execute(args,ctx)}`). Best practice: keep the logic in the skill `handler.js`
and `require()` it from `baseWebTools()` so both entry points share one impl.

**How to apply:** to add a chat-reachable tool — (1) create
`backend/src/skills/<id>/{manifest.json,handler.js}`, (2) require the handler in
`baseWebTools()` and return a full-JSON-Schema tool entry. Verify with
`node -e "require('./src/services/skills/registry').load()"` (errors must be
none) before relying on it.
