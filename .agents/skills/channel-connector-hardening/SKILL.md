---
name: channel-connector-hardening
description: Adapt OpenClaw-style channel, archive, and connector reliability patterns to SiraGPT providers, chat flows, and backend integrations.
version: 0.1.0
metadata:
  inspired_by:
    - channel-message-flows
    - discrawl
    - gitcrawl
    - slacrawl
    - notcrawl
    - graincrawl
---

# Channel Connector Hardening

Use this for SiraGPT work involving chat delivery, provider routing, external connectors, archive lookup, transcript handling, or message-flow reliability.

## Contract

- Treat OpenClaw channel tools as patterns, not as SiraGPT dependencies.
- Keep provider credentials out of code, tests, logs, and generated artifacts.
- Prefer deterministic fixtures before live-channel proof.
- For chat behavior, verify both backend event shape and visible frontend state only when UI scope is open.
- For no-UI work, stop at backend contracts, SSE events, route tests, and message persistence tests.

## SiraGPT Surfaces

- `backend/src/routes/ai.js`
- `backend/src/services/agents/semantic-intent-router.js`
- `backend/src/services/sira/sse-structured-events.js`
- `backend/src/services/message-attachments.js`
- `backend/src/services/chat-attachment-recovery.js`
- `backend/tests/*message*`
- `backend/tests/*sse*`

## Validation

```bash
node --test backend/tests/sira-chat-controller-contextual-understanding.test.js
node --test backend/tests/message-attachments.test.js
npm test
bash scripts/verify-ui-lock.sh
```
