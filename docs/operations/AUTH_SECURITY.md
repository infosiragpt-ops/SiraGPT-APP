# Authentication security operations

This rollout changes persisted session tokens, OAuth callback state, and
super-admin impersonation limits without changing the Prisma schema.

## Session-token storage

The rollout has two mandatory phases:

1. Deploy `SESSION_TOKEN_HASH_MODE=compat`. Compat reads raw or hashed rows,
   writes raw tokens, and never upgrades a row. Keep this mode until every
   pre-compat replica and rollback candidate is drained.
2. After the drain, set `SESSION_TOKEN_HASH_MODE=hash` and
   `SESSION_TOKEN_HASH_COMPAT_DRAINED=1`. Production startup blocks a hash-mode
   process without that acknowledgement.

Hash mode stores a bounded, versioned representation in `Session.token`:
`sira:session-token:v1:<session|appshots>:<sha256>`. The SHA-256 digest is
domain-separated (`siragpt:session-token:v1\0<token>`), while the prefix
preserves the verified JWT scope class without making the bearer reversible.
Listing and revocation classify versioned rows from that prefix and never try
to decode a digest.

Hash activation first converts all plaintext rows. It uses transactions of at
most `SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE` rows and performs at most
`SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES` transactions per readiness pass.
Each row's Appshots scope is derived only after verifying the JWT signature
(expiration is ignored for classification). Readiness remains blocked until
the bounded passes report no plaintext rows; later probes resume the work.
Concurrent upgrades use an atomic compare-and-swap, and revocation covers raw,
versioned, and pre-release digest representations. Do not log, audit, export,
or manually copy the presented bearer. Health telemetry reports progress but
never token material.

## Distributed OAuth state

Google login, Gmail, Google Services, Spotify, and GitHub all issue signed
state through the same bounded one-time store. Every state binds the provider,
user (or pre-login browser-session digest), and exact redirect URI. Its Redis
entry has the JWT's TTL and an atomic consume prevents replay across replicas.

Redis stores a SHA-256 digest of the JTI in the key and a small binding payload,
not provider tokens. The client has no offline queue and every connect and
command has a hard timeout. In production Redis is mandatory and an outage
fails closed. Development and test may use a bounded memory fallback, which is
not suitable for multi-replica callback traffic.

Every JTI is cryptographically random. The configured TTL is clamped to one
through 15 minutes, and the matching Redis record receives the same expiry.

Production readiness executes a harmless Lua probe, requires
`maxmemory-policy noeviction`, and checks memory capacity against
`AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO`. OAuth and impersonation Lua keys use
shared Redis Cluster hash tags so every script touches one slot.

Operational checks:

1. Confirm `REDIS_URL` is shared by every backend replica.
2. Confirm issuer and callback replicas use the same `JWT_SECRET`, OAuth state
   prefix, callback URL, and clock source.
3. Treat replay/expiry errors as rejected callbacks; never retry token exchange
   with a consumed state.
4. Do not reduce the state TTL below the provider's expected consent round trip.

All provider callback and post-callback destinations are resolved centrally.
Production requires HTTPS and rejects localhost for Google/Gmail, GitHub, and
Spotify URLs. A state-store outage returns an actionable `503` with a bounded
`Retry-After`; it never proceeds to provider token exchange.

## Distributed impersonation limiting

Each allowed attempt atomically consumes two sliding windows: the
`admin + target` bucket and the global admin bucket. Identifiers are
domain-separated SHA-256 digests in Redis keys. Keys expire with the configured
window, so the distributed footprint remains bounded.

An exhausted window returns `429`; a required-store outage returns `503`.
Both include a bounded `Retry-After` header. Record every denial as
`impersonate_denied` with a reason and limiter dimension, but never include a
session bearer.

## Health and lifecycle

`GET /health` exposes safe auth-security health and config. In production,
`GET /health/ready` returns `503` when either distributed runtime is
unavailable or the session backfill is incomplete. Startup primes the stores
and backfill before accepting traffic. Every readiness probe may retry a failed
Redis/backfill `ready()` call; exponential backoff is bounded by
`AUTH_SECURITY_READY_RETRY_BASE_MS` and `AUTH_SECURITY_READY_RETRY_MAX_MS`, so
the service recovers without restart while avoiding a Redis retry storm.
Graceful shutdown closes owned Redis clients through the central shutdown
registry.

Auth-security close failures are surfaced by the shutdown registry. Any close
failure makes the process exit non-zero so an orchestrator cannot mistake a
partial shutdown for a clean drain.

Use the health payload to verify:

- `oauthState.mode` and `impersonation.mode` are `redis`;
- both report `distributed: true`;
- `sessionTokens.complete` is `true` before enabling hash-mode traffic;
- `readinessRetry.attempt` returns to `0` after recovery;
- `offlineQueue` is `false`;
- no Redis URL or credential appears in health/config output.
