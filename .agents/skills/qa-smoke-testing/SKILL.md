---
name: qa-smoke-testing
description: "Choose and run focused SiraGPT QA smoke tests for backend, chat, models, billing, documents, agents, and production readiness."
---

# QA Smoke Testing

Use this skill after implementing backend/runtime changes and before pushing or deploying.

## Contract

- Run the smallest meaningful test first, then broaden based on risk.
- Do not claim completion without at least one automated proof or a clear blocker.
- Production changes require health/version verification after deploy.
- Keep test output summaries short and actionable.

## Test Lanes

### Fast Code Lane

```bash
npm run type-check
node --test backend/tests/model-sync-service.test.js backend/tests/provider-inference.test.js
```

### Provider/Model Lane

```bash
node --test backend/tests/video-provider.test.js backend/tests/provider-external-probe.test.js
curl -sS 'https://api.siragpt.com/api/ai/models?type=VIDEO'
```

### Chat Lane

```bash
node --test backend/tests/plan-quota.test.js backend/tests/charge-credits-middleware.test.js
npm run smoke:local-chat:compact
```

### Release Lane

```bash
npm run build
curl -sS https://api.siragpt.com/api/version
curl -sS -o /dev/null -w '%{http_code}\n' https://api.siragpt.com/health/ready
```

## Escalation

- If a focused test fails, fix that layer before running the full build.
- If local passes but production fails, compare deployed commit and env names.
- If CI fails after push, inspect failing job logs, patch narrowly, push again, and monitor until green.

