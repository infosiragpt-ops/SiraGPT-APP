---
name: Frontend API mutation transport
description: State-changing /api calls from the Next.js frontend must use authenticatedFetch (CSRF-aware), never raw fetch; match server enum contracts.
---

Rule: any state-changing (POST/PUT/PATCH/DELETE) call to `/api/*` from the SiraGPT-APP frontend must go through `authenticatedFetch` (`lib/authenticated-fetch.ts`) or a domain client built on it (e.g. `coworkApi` in `lib/cowork-api.ts`). Never hand-roll `fetch` with only a bearer header.

**Why:** cookie-authenticated sessions require the CSRF token flow (`csrf_token` cookie + `/auth/csrf-token` acquisition + retry-on-invalid) that `authenticatedFetch` implements; a raw `fetch` gets 403 on mutation routes for users without a local bearer token. This shipped once in the /code coworkers panel and also carried a wrong enum (`decision: "approve"` — the cowork approvals API only accepts `allow` | `deny`), so the approve button 400/403'd in every path.

**How to apply:** when adding UI that mutates server state, first look for an existing domain client (coworkApi etc.) and extend it rather than duplicating transport. Verify request enums against the backend route/service (e.g. `backend/src/services/agent-harness/permission-manager.js`) instead of guessing from UI labels.
