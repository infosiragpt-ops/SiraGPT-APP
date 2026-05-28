---
name: security_triage
description: Review security-sensitive backend changes, secret exposure, unsafe file access, auth bypasses, and dependency risk.
version: 0.1.0
---

# Security Triage

Use this for auth, file handling, external fetches, webhooks, secrets, payments, admin routes, and user-generated content.

Checklist:

1. Identify the trust boundary: caller, tenant, org, session, API key, or public request.
2. Confirm authorization happens before data access or side effects.
3. Check that file paths, URLs, redirects, and webhook payloads are normalized and constrained.
4. Verify secrets are not logged, returned, cached, or exposed through skill env grants.
5. Prefer deny-by-default behavior when validation is uncertain.
6. Add a regression test for the blocked unsafe path.

Escalate if a change could expose private user data, allow cross-tenant access, or weaken payment/admin controls.
