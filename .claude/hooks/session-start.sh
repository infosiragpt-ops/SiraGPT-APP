#!/bin/bash
# Instala el CLI de OpenSpec que usan las skills /openspec-* (.claude/skills/openspec-*).
# Solo en sesiones en la nube; en local cada quien lo instala con npm.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

OPENSPEC_VERSION="1.14.0"
if ! command -v openspec >/dev/null 2>&1 || [ "$(openspec --version 2>/dev/null)" != "$OPENSPEC_VERSION" ]; then
  npm install -g "@fission-ai/openspec@${OPENSPEC_VERSION}" >/dev/null 2>&1
fi
