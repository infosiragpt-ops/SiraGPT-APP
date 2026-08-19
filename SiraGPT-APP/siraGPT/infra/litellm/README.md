# Sira LLM Gateway (litellm Proxy on Replit Autoscale)

Production-grade façade in front of OpenAI, Anthropic, Gemini, DeepSeek and
OpenRouter. The backend talks to this proxy via the OpenAI SDK pointed at
`LLM_GATEWAY_URL`; the proxy holds every provider key and applies the
fallback chains declared in [`config.example.yaml`](./config.example.yaml).

This directory is **infrastructure config**. It does not run inside the main
backend — it is deployed as a separate Replit Autoscale service.

---

## Why this exists

- Today: every route that calls an LLM instantiates `new OpenAI({apiKey, baseURL})`
  on its own and implements its own retry/fallback. Adding a new provider
  (Bedrock, Azure, Vertex…) means touching every call site.
- With the gateway: one HTTP endpoint, one shared key, one yaml file with
  the routing rules. New providers ship by editing the yaml.
- Bonus: gateway-side rate limits / budgets per user, a single observability
  funnel into Langfuse (Task #41), and the ability to swap providers without
  redeploying the backend.

## Architecture

```
   ┌──────────────┐    HTTPS (Bearer LLM_GATEWAY_KEY)    ┌──────────────────────┐
   │ Sira backend │ ────────────────────────────────────▶│ litellm Proxy        │
   │ (Autoscale)  │                                       │ (Autoscale, this dir)│
   └──────────────┘                                       └────────┬─────────────┘
                                                                  │
                                                                  ▼
                                         OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter
```

The backend wraps the OpenAI SDK in
[`backend/src/services/ai/llm-gateway-client.js`](../../backend/src/services/ai/llm-gateway-client.js).
That client returns `null` when `LLM_GATEWAY_URL` is unset, so every call
site can fall back to the legacy direct-provider client during the rollout.

## Deploying the proxy

1. **Create a new Repl** of type "Empty (Docker)" or "Node.js". The proxy
   itself is a Python image; we use Docker via Replit's container runtime.
2. **Add a `Dockerfile`** (one liner):
   ```dockerfile
   FROM ghcr.io/berriai/litellm:main-latest
   COPY config.yaml /app/config.yaml
   CMD ["--config", "/app/config.yaml", "--port", "4000"]
   ```
3. **Copy** `infra/litellm/config.example.yaml` into the Repl as `config.yaml`.
   Edit only if you need to add a new model — leave the fallbacks alone for
   parity with the Node `failover-policy.js`.
4. **Set proxy secrets** in the Repl (NOT the main backend Repl):
   - `OPENAI_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `GEMINI_API_KEY`
   - `DEEPSEEK_API_KEY`
   - `OPENROUTER_API_KEY`
   - `LITELLM_MASTER_KEY` — generate one (`openssl rand -hex 32`). This is
     the shared secret the backend will send as Bearer.
   - `DATABASE_URL` — optional, enables built-in spend tracking.
5. **Publish** as an Autoscale deployment. Port `4000`. Health check
   `/health`. Min instances `1` so the first user-facing request doesn't
   pay a cold start.
6. **Copy the deployment URL** (e.g. `https://sira-llm-gateway.replit.app`).

## Wiring the backend

Add two secrets to the *main* Sira backend Repl:

| Secret               | Value                                              |
|----------------------|----------------------------------------------------|
| `LLM_GATEWAY_URL`    | `https://sira-llm-gateway.replit.app/v1`           |
| `LLM_GATEWAY_KEY`    | Same value you set as `LITELLM_MASTER_KEY` above   |

Optional tuning:

| Secret                    | Default | Purpose                                          |
|---------------------------|---------|--------------------------------------------------|
| `LLM_GATEWAY_TIMEOUT_MS`  | `60000` | Per-request timeout from the SDK side            |
| `LLM_GATEWAY_MAX_RETRIES` | `2`     | OpenAI-SDK-level network retries before failure  |
| `LLM_GATEWAY_FORCE`       | unset   | `1` routes ALL traffic through the gateway       |

With `LLM_GATEWAY_FORCE` unset (the default), the gateway is only used for
requests that carry the header `x-sira-gateway: 1`. This is how we roll
out to 10 % of traffic for 48 h before flipping to 100 %.

## Validation runbook

```bash
# Sanity check the proxy is reachable with curl, no SDK involved:
curl -sS "$LLM_GATEWAY_URL/chat/completions" \
  -H "Authorization: Bearer $LLM_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# Backend-side: enable the header on a single chat turn from the browser
# devtools (Network → Right-click → "Resend with header") and confirm:
# - Langfuse shows the trace with provider="openai" (post-fallback)
# - The backend log line `[ai/generate] via=gateway` appears
```

## Rollback

If the gateway misbehaves: leave the secrets in place but set
`LLM_GATEWAY_FORCE` to `0` (or delete the secret entirely). The header
opt-in only activates for explicitly tagged requests, so the worst case is
nobody opts in. To completely disable from the backend without redeploying
the proxy, unset `LLM_GATEWAY_URL` — the client factory returns `null` and
every call site falls back to the legacy direct path.

## What this turn does NOT do

- Stand up the actual Replit Autoscale Repl (manual user step).
- Migrate the `new OpenAI(...)` call sites in `backend/src/routes/ai.js`
  (huge surface; staged in a follow-up so each migration can ship with
  its own tests).
- Move `failover-policy.js` to read-only metadata (depends on the proxy
  being live and validated in production for a week).
- Wire the litellm semantic cache (task #42 explicit out-of-scope).
