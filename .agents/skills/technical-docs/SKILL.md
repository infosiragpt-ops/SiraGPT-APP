---
name: technical-docs
description: "Create and maintain SiraGPT technical documentation, agent instructions, runbooks, and operational notes that stay aligned with the codebase."
---

# Technical Docs

Use this skill for codebase documentation, agent instruction files, runbooks, architecture notes, and operational checklists.

## Contract

- Docs must match current code and commands.
- Prefer short runbooks with exact paths and commands over generic prose.
- Do not document secrets, private topology, or credentials.
- Keep Spanish user-facing notes direct; keep engineering docs clear enough for future maintainers.
- Update docs only when behavior, commands, or operational practice changed.

## Workflow

1. Identify source of truth: code, script, workflow, env docs, or production behavior.
2. Read adjacent docs before adding a new file.
3. Use existing docs structure under `docs/`, `.agents/skills/`, or backend README.
4. Add validation notes: what command was checked and when.
5. If docs describe a workflow, include rollback or failure path.

## Good Targets

- Deploy runbooks.
- Provider/model sync notes.
- Agent skill contracts.
- Security/secret handling.
- CI failure triage.
- Production smoke checks.

## Validation

```bash
npm run skill:list -- --root .agents/skills --json
rg -n 'TODO|FIXME|your-token|api-key-here' docs .agents/skills
```

