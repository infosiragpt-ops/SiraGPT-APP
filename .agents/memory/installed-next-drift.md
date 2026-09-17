---
name: Installed Next.js version drift
description: Check installed framework version before changing hydration code in this workspace.
---

Compare the installed Next.js version with both the manifest and lockfile before diagnosing hydration failures or unsupported configuration.

**Why:** The workspace executed an older major version despite agreeing newer manifest and lockfile pins. This produced misleading hydration and config errors. The pinned release was also rejected by the package security policy, requiring a permitted patch within the same major.

**How to apply:** Verify the installed version independently. Restore a permitted compatible patch without bypassing security policy; do not mask hydration errors or rewrite the layout merely to accommodate stale dependencies.