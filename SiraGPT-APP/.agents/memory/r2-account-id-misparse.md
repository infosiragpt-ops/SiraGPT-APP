---
name: R2 account-id mispaste → ENOTFOUND https
description: Why R2 fails with "getaddrinfo ENOTFOUND https" and how to fix without re-entering the secret.
---

# R2 "getaddrinfo ENOTFOUND https"

**Symptom:** S3/R2 calls fail with `getaddrinfo ENOTFOUND https`. The literal
hostname being resolved is `https`.

**Cause:** `R2_ACCOUNT_ID` was set to the **full S3 endpoint URL**
(`https://<acct>.r2.cloudflarestorage.com`) instead of the bare 32-hex account
id. Endpoint derivation is `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
so it becomes `https://https://...` and the URL parser reads the host as
`https`. Users pasting from the Cloudflare token screen frequently grab the
"endpoint" line by mistake.

**Fix (no secret re-entry needed):** `r2-storage.js` honors `R2_ENDPOINT` with
priority over the derived endpoint. `R2_ENDPOINT` is NOT sensitive (the account
id appears in every request URL and on the dashboard), so set it as a plain
shared env var: `R2_ENDPOINT=https://<32hex>.r2.cloudflarestorage.com`. Extract
the 32-hex from the malformed value with `/[0-9a-f]{32}/i`.

**Why:** account id is non-secret, secrets can't be set programmatically, and
`R2_ENDPOINT` override sidesteps the broken derivation cleanly.

**How to apply:** when R2 round-trip throws `ENOTFOUND https`, inspect the SHAPE
of `R2_ACCOUNT_ID` (length, contains `://`) without printing it; if it carries a
URL, set `R2_ENDPOINT` instead of asking the user to redo the secret.

## Related: embeddings provider gotcha
The code's default user-memory embed provider is `voyage`; a stale/invalid
`VOYAGE_API_KEY` returns 401 "Provided API key is invalid". Always test an
existing embedding key (tiny embeddings call) before assuming it works —
presence of the secret ≠ validity. Switching to `jina` needs
`SIRAGPT_MEMORY_EMBED_PROVIDER=jina` + `JINA_API_KEY`; durable store also needs
`SIRAGPT_USER_MEMORY_STORE=pgvector` and the pgvector migration applied.
