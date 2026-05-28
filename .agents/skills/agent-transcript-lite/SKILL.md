---
name: agent-transcript-lite
description: "Create safe, minimal implementation provenance summaries for SiraGPT commits, PRs, issues, and handoff notes without leaking private session logs."
---

# Agent Transcript Lite

Use this skill when summarizing autonomous work for a commit, PR, issue, memory note, or user handoff.

## Contract

- Do not attach raw session logs.
- Do not include hidden prompts, chain-of-thought, tool raw dumps, tokens, cookies, env values, or unrelated user messages.
- Summarize decisions, files touched, tests run, deploy/CI status, and blockers.
- Scope the transcript to the current task only.
- Ask before adding provenance to a public PR/issue body.

## Safe Summary Shape

```markdown
## Implementation Notes

- Goal:
- Approach:
- Files touched:
- Validation:
- Deploy/CI:
- Remaining risk:
```

## Redaction Rules

- Replace secret values with key names: `FAL_API_KEY configured`, not the value.
- Replace local private paths with repo-relative paths when possible.
- Omit unrelated chat history.
- Omit failed experiments unless they explain current behavior or risk.

## Use In SiraGPT

- Daily memory: concise durable summary only.
- Telegram status: user-facing outcome, no raw logs.
- PR body: include validation and risk, not private transcript.
- Incident note: include timeline, symptom, root cause, fix, verification.

