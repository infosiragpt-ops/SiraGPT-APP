---
name: Reserved VM GCLB 30s hard timeout
description: On Reserved VM (GCE), the Google Cloud Load Balancer enforces a hard ~30s total-response timeout that heartbeats do NOT reset — unlike Autoscale.
---

# Reserved VM (GCE) GCLB ~30s hard response timeout

On a Replit **Reserved VM** deployment, traffic is fronted by a Google Cloud
Load Balancer (source IPs `35.191.x.x` in deployment logs). The GCLB enforces a
**hard ~30s total-response timeout**: it cuts the connection ~30s after the
request starts (observed `durMs` ~31000–31600) with `[Error: aborted] code:
'ECONNRESET'`, regardless of how much data has already been streamed.

**Why this matters / what broke:** The "send 200 headers early + emit a space
every 5s" keep-alive trick works on **Autoscale** (whose ~30s limit is an
*idle/time-to-first-byte* window the heartbeats reset) but **NOT on Reserved
VM**, because GCLB's limit is on *total* response time, not idle time.
Heartbeats cannot extend it. This is the opposite premise from
`sse-heartbeat-proxy-idle.md` — that note's reasoning only holds on Autoscale.

**How to apply (pattern for long operations >30s, e.g. image generation):**
Do NOT rely on keeping the HTTP request alive. Instead **decouple the work from
the request**:
1. Validate inputs (e.g. chatId ownership) up front.
2. On client disconnect, distinguish a **real user cancel** (socket closes
   *before* ~28s → abort the provider) from the **GCLB cut** (socket closes at
   ~28–30s with a valid persistence target → keep running, do NOT abort).
3. Let the backend finish and **persist the result** (success or a failure
   message) to durable storage (the chat).
4. The frontend, when its POST is cut (network error, no HTTP status, elapsed
   ≥ ~25s, error has no app `code`), **polls** the durable store until the
   result (or persisted error) appears, then reloads.

**Why:** Any backend operation that can exceed ~30s on Reserved VM will be cut
mid-flight; the only reliable delivery channel is persist-then-poll, not the
original request/response.
