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
  Further ports are governed by docs/code/openclaw-port-charter.md.
