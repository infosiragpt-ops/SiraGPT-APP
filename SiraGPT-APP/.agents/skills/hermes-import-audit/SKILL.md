---
name: hermes-import-audit
description: Audit, attribute, and adapt MIT-licensed Hermes Agent skills and runtime patterns into SiraGPT without activating upstream code directly.
version: 0.1.0
metadata:
  generated_by: backend/src/services/agents/hermes-playbook-bridge.js
---

# Hermes Import Audit

Use this when importing or reviewing Hermes Agent references, optional skills,
toolsets, compaction patterns, plugins, gateway flows, cron flows, and TUI/CLI
patterns for SiraGPT.

## Contract

- Keep upstream Hermes files reference-only under `.agents/hermes-upstream`.
- Rewrite active SiraGPT behavior in native files under `backend/src`,
  `.agents/skills`, `scripts`, or `docs`.
- Preserve MIT attribution in `.agents/hermes-upstream/SNAPSHOT.json` and
  upstream license/reference docs.
- Never expose local secrets, tokens, cookies, user files, or private runtime
  logs while writing handoffs.
- Do not change SiraGPT UI while adapting Hermes patterns unless the product
  request explicitly asks for UI work.

## Workflow

1. Run `npm run agent:hermes:map -- --json` and identify uncovered or partial
   capability areas.
2. Read the upstream Hermes reference only for the relevant folder or skill.
3. Re-express the behavior in SiraGPT-native architecture.
4. Add focused tests for the rewritten behavior.
5. Run the cheapest safe proof:

```bash
npm run agent:hermes:map -- --json
npm run skill:validate:agents
npm test -- --test-name-pattern=hermes
```

## Done Means

- The Hermes capability appears in the map as covered or intentionally
  reference-only.
- Active code does not import from `.agents/hermes-upstream`.
- Tests or a validation command prove the rewritten SiraGPT behavior.
- Any copied reference material remains inactive and attributed.
