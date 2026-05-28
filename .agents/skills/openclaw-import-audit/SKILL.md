---
name: openclaw-import-audit
description: Audit, copy, attribute, and adapt MIT-licensed OpenClaw agent skills into SiraGPT without leaking OpenClaw-specific infrastructure into active runtime workflows.
version: 0.1.0
metadata:
  source: https://github.com/openclaw/openclaw
  upstream_snapshot: .agents/openclaw-upstream
  license: MIT
---

# OpenClaw Import Audit

Use this when importing OpenClaw ideas, playbooks, or code into SiraGPT.

## Contract

- Verify `./.agents/openclaw-upstream/LICENSE` exists before using copied upstream material.
- Keep verbatim upstream copies under `./.agents/openclaw-upstream`; do not activate them directly.
- Rewrite active SiraGPT instructions under `./.agents/skills` with SiraGPT paths, scripts, endpoints, and CI gates.
- Preserve UI-lock constraints unless the user explicitly requests interface changes.
- Do not copy OpenClaw credentials, hostnames, private maintainer assumptions, Discord/Slack IDs, or release-only operations into SiraGPT.
- Record the upstream commit SHA when adding or refreshing a snapshot.

## Workflow

1. Check current repo state:
   ```bash
   git status --short
   git rev-parse HEAD
   ```
2. Refresh the upstream reference outside the active repo if needed:
   ```bash
   git -C /tmp/openclaw-reference fetch --depth=1 origin main
   git -C /tmp/openclaw-reference reset --hard origin/main
   ```
3. Copy only into the inactive snapshot namespace:
   ```bash
   mkdir -p .agents/openclaw-upstream
   cp -R /tmp/openclaw-reference/.agents/skills .agents/openclaw-upstream/skills
   cp /tmp/openclaw-reference/LICENSE .agents/openclaw-upstream/LICENSE
   ```
4. Build the integration map:
   ```bash
   npm run agent:openclaw:map -- --json
   ```
5. Adapt active SiraGPT skills and backend routing.
6. Validate:
   ```bash
   npm run skill:validate:agents
   node --test backend/tests/openclaw-playbook-bridge.test.js
   bash scripts/verify-ui-lock.sh
   ```

## Acceptance

- Upstream snapshot is namespaced and attributed.
- Active SiraGPT skills validate with zero registry issues.
- Backend map recommends SiraGPT-native playbooks, not raw OpenClaw workflows.
- No frontend/UI files are changed unless explicitly requested.
