# Task for Task Store + Tool Registry Terminal

## Priority: Medium

Add **service health probes** for agent services:

1. Create `backend/src/services/agents/service-health.js`:
   - `checkAgentHealth()` — verifies agent-core.js is responsive
   - `checkTaskStoreHealth()` — tests task-store.js read/write
   - `checkToolRegistryHealth()` — verifies tool-manifest.js utilities work
   - `checkDocumentPipelineHealth()` — verifies document-pipeline-registry.js
   - Each returns `{ ok: boolean, latencyMs: number, error?: string }`
   - Singleton cache with 30-second TTL
2. Create `backend/tests/service-health.test.js` with 4 tests
3. Export all health check functions
4. TEST: `npm test` in backend/
5. PUSH: `git add -A && git commit -m "feat(agents): add service health probes" && git push sira-org main`
