---
name: biblioteca-deposit
description: Persist a skill report, plan, or markdown artifact into SiraGPT Biblioteca for the owning user. Use after a curator pass, a plan, or a document the user should find later.
---

# Biblioteca Deposit

Use this skill when a PLANIFICAR or skill-curator turn produces a durable
markdown/plan artifact that must survive reload and stay inside the owning
user's Biblioteca.

## Contract

- Deposit through `backend/src/services/agents/hermes-biblioteca.js`.
- Every write is keyed by `userId`. User B never reads User A.
- `brand_label` is **SiraGPT**. Never a vendor name or raw `model_id`.
- Do not change composer, chips, or other UI-lock surfaces.
- Do not dump Hermes upstream files. Rewrite behavior natively.

## Workflow

1. Produce the report or plan in markdown.
2. Call `hermes-biblioteca.deposit({ userId, chatId, title, body, kind })`.
3. Confirm the returned `asset_id` is owner-scoped.
4. Mid-chat writes persist immediately; listing is `listForUser(userId)`.
5. Skill-curator promotes include `hash` + `procedencia` in the markdown body.
   Same hash → skip. Same name, different hash → merge provenance, do not dump upstream.

## Hermes pattern

Adapted from NousResearch/hermes-agent (MIT) curator `REPORT.md` landing —
not a copy of the Python curator.
