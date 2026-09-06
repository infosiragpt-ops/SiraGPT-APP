# Third-party notices

Attributions for third-party ARCHITECTURE adapted into this codebase.
(Package licence texts live in the generated THIRD_PARTY_LICENSES.md —
do not add entries there by hand; the licenses CI gate regenerates it.)

- **OpenClaw** (https://github.com/openclaw/openclaw, MIT License) — the
  channel DM-pairing/allowlist security model, adapter contract, registry and
  Telegram adapter in `backend/src/services/business-channels/` are clean-room
  native rewrites derived from OpenClaw's `src/pairing` and `src/channels`
  architecture (code alphabet, TTL, pending cap, signature-first ingress and
  create-if-missing decisions preserved by design).
  The complete OpenClaw copyright and MIT license text is retained at
  `docs/upstream/OPENCLAW-LICENSE`.
  The native ReAct tool-result integrity and call-identity hardening in
  `backend/src/services/react-agent.js` and `agents/tool-call-normalizer.js`
  also draws on OpenClaw's no-progress detection and replay-safe tool pairing
  architecture. The history packer in `agentic-chat-stream.js` uses the
  complete-turn retention concept reviewed in the existing inactive OpenClaw
  reference snapshot; its upstream revision was not independently verified.
  This is a SiraGPT-owned implementation, not a vendored gateway
  or provider adapter. Audited references and scope are recorded in
  `docs/agent-brain-integrity-20260906.md`.
  Further ports are governed by docs/code/openclaw-port-charter.md.

- **OpenCode** (https://github.com/anomalyco/opencode, MIT License) —
  SiraCode (`backend/src/services/sira-code/`) is an **independent rewrite**
  inspired by OpenCode's session/prompt loop, build vs plan agents, and
  permissioned tools (read / edit / bash / grep). No OpenCode source, SST
  console, Nix, desktop, Electron, or TUI was vendored into this tree.
  SiraGPT / SiraCode is **not affiliated with** OpenCode or Anomaly.
  The upstream MIT license text is retained at `vendor/opencode/LICENSE`
  for the historical sidecar reference only; the native engine does not
  depend on that tree.

- **Simple Icons** (https://simpleicons.org/, CC0 1.0) — brand-colored SVGs
  under `public/conexiones-logos/` used as official marks on `/conexiones`
  and `/gpts` app cards.
