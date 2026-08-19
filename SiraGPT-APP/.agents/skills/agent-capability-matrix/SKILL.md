---
name: agent-capability-matrix
description: Maintain a capability matrix across OpenClaw upstream skills, SiraGPT active agent skills, backend services, scripts, tests, and CI gates.
version: 0.1.0
metadata:
  generated_by: backend/src/services/agents/openclaw-playbook-bridge.js
---

# Agent Capability Matrix

Use this when deciding what SiraGPT already has, what OpenClaw has, and what should be adapted next.

## Contract

- Compare by capability, not by identical folder names.
- Mark each upstream capability as `covered`, `adapted`, `partial`, `reference-only`, or `not-applicable`.
- For every new active skill, include a SiraGPT validation command.
- Keep copied upstream materials in `.agents/openclaw-upstream` and active SiraGPT materials in `.agents/skills`.

## Command

```bash
npm run agent:openclaw:map -- --json
```

## Decision Rules

- `covered`: SiraGPT already has a direct active skill.
- `adapted`: SiraGPT has a rewritten equivalent with different names or commands.
- `partial`: SiraGPT has some pieces but lacks a workflow, proof, or backend route.
- `reference-only`: useful upstream material, but not safe to activate.
- `not-applicable`: OpenClaw-specific infra, accounts, release channels, or app targets.
