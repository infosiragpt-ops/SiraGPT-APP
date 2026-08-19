# OpenClaw Upstream Snapshot

This folder stores a namespaced copy of OpenClaw agent skills for SiraGPT adaptation work.

- Source repository: https://github.com/openclaw/openclaw
- Source commit: `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`
- Copied path: `.agents/skills`
- License: MIT, preserved in `./LICENSE`

## Policy

Do not load these files directly as active SiraGPT skills. Treat them as upstream reference material. Active SiraGPT playbooks live under `../skills` and must be rewritten for SiraGPT paths, commands, safety rules, CI, production verification, and UI-lock constraints.

## Integration Flow

1. Read the upstream skill here.
2. Map it to one or more SiraGPT active skills in `../skills`.
3. Keep OpenClaw-specific commands, credentials, release names, and infrastructure out of SiraGPT runtime paths.
4. Preserve attribution when substantial upstream text or structure is reused.
5. Validate active SiraGPT skills with `npm run skill:validate:agents`.
