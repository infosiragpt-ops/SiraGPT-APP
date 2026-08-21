# Ola OSS rewrite 2026-08-18 16:20 America/Lima

Post-3H22. Backend only. Ideas from /opt/referencias-agentes. No vendor source copied.

A tool-repair vercel/ai: engine-control.js loop.js. Metric: extras stripped; exhaustion stops generate.
B SSE LibreChat: hydrate Redis + orphan close. Metric: replayed>=1; stale closed.
C loop Mastra/VoltAgent: token_budget + persistAgentRun. Metric: token cap stops; steps stored.

Tests 25/25 oss + 38/38 3H22. Smoke chat/code/health 200.
