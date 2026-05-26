---
name: runtime_debugging
description: Diagnose backend runtime failures by collecting logs, narrowing the failing path, and proving the fix with the smallest reliable check.
version: 0.1.0
---

# Runtime Debugging

Use this when a route, worker, provider call, stream, or background job fails in production or local development.

Workflow:

1. Capture the exact failing entry point, input shape, request id, and timestamp.
2. Read the closest route, service, adapter, and test before changing code.
3. Prefer a small reproduction over broad speculation.
4. Separate configuration problems from code regressions.
5. Patch the narrowest backend path that explains the observed failure.
6. Verify with a focused unit or integration test, then run the cheapest broader gate affected by the change.

Report:

- Root cause in one or two concrete sentences.
- Files changed.
- Verification command and result.
- Any remaining risk if a live dependency could not be exercised locally.
