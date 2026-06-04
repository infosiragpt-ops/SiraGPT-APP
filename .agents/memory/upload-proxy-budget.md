---
name: Upload sync-path proxy budget
description: Why /files/upload synchronous post-processing must stay under the ~30s proxy cut and how it's bounded
---

# Upload synchronous-path response budget

The synchronous `/api/files/upload` path (processFilesInParallel) runs
extraction, thumbnail, OpenAI Files upload, and document analysis *inside the
HTTP request* before responding. The reverse proxy / GCLB cuts any request at
~30s regardless of SSE heartbeats (see reserved-vm-gclb-timeout), so an
unbounded slow upstream surfaces to the user as a FAILED upload even though the
binary is already safely on disk.

**Rule:** every best-effort step in the sync path must be individually
timeout-bounded AND the independent steps (extract / thumbnail / OpenAI) run
concurrently via Promise.all so worst-case wall-clock is max(step), not sum.
analyzeFile is also timeout-bounded. Budgets live in env-overridable consts
(SIRAGPT_EXTRACT/THUMBNAIL/OPENAI_FILE/ANALYZE_TIMEOUT_MS) kept so their max +
analyze stays comfortably < 30s.

**Why:** sequential summing (20+12+22+unbounded) blew past 30s under a degraded
OpenAI/parser and produced spurious "upload failed" for production users, even
though the upload itself had succeeded.

**How to apply:** when adding any new awaited step to the sync upload path,
bound it with withTimeout() and prefer running it concurrently with the other
independent steps — or defer it to the background (scheduleFileAfterFastUpload /
setImmediate), which has no proxy budget. The async preview path
(processFilesForAsyncPreview) already does all heavy work in the background and
is the safest pattern for anything that can be slow.
