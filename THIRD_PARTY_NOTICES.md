# Third-party notices

Attributions for third-party ARCHITECTURE adapted into this codebase.
(Package licence texts live in the generated THIRD_PARTY_LICENSES.md —
do not add entries there by hand; the licenses CI gate regenerates it.)

- **OpenClaw** (https://github.com/openclaw/openclaw, MIT License) — the
  channel DM-pairing/allowlist security model in
  `backend/src/services/business-channels/` is a clean-room native rewrite
  derived from OpenClaw's `src/pairing` architecture (code alphabet, TTL,
  pending-cap and create-if-missing decisions preserved by design).
  Further ports are governed by docs/code/openclaw-port-charter.md.
