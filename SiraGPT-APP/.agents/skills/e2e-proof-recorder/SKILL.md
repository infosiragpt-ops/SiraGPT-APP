---
name: e2e-proof-recorder
description: Capture deterministic proof for SiraGPT changes using OpenClaw-style smoke, E2E, CI, and artifact discipline without over-testing unrelated surfaces.
version: 0.1.0
metadata:
  inspired_by:
    - control-ui-e2e
    - openclaw-testing
    - openclaw-qa-testing
    - crabbox
    - telegram-crabbox-e2e-proof
---

# E2E Proof Recorder

Use this when a change needs strong evidence: local smoke, browser proof, backend boot proof, CI watch, production health, or artifact capture.

## Contract

- Choose the cheapest proof that covers the changed behavior.
- Do not use live credentials unless explicitly required and safe.
- For backend-only changes, prefer unit/route/boot tests plus UI lock before browser work.
- For UI changes, use Playwright screenshots or visual regression and inspect failures before accepting snapshots.
- On `main`, treat the newest SHA as authoritative; cancelled older runs are stale.

## Proof Lanes

| Risk | Proof |
|---|---|
| Skill docs only | `npm run skill:validate:agents` |
| Backend service | focused `node --test`, then `npm test` |
| Type/runtime contract | `npm run type-check -- --pretty false` |
| UI protected | `bash scripts/verify-ui-lock.sh` |
| Production release | `gh run watch`, then public endpoint `200` checks |
| Browser behavior | Playwright or Browser/Computer Use screenshot proof |

## Output

End with:

- final SHA when pushed
- exact local gates
- newest GitHub Actions status
- production endpoint status when relevant
- any skipped proof and why
