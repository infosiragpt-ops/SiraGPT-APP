---
name: codex-playbooks
description: Use when editing a git repo in /code — exact unified diff, git-clean check, syntax verify, revert on fail.
---

# codex-playbooks — aplicar diffs con git en /code

Este playbook es de SiraGPT (no se copió de un vendor). Cubre los recipes
vivos de Codex en este árbol: apply_patch, read-after-write y verificación.

## Cuándo usar

- El usuario pide un cambio en un archivo de un repo (/code).
- Hay un diff unificado o un reemplazo exacto.

## Receta

1. `read_file` del destino. No inventes el contexto.
2. Confirma que el working tree de ESE archivo está limpio (git-aware).
   Si está sucio, detente y reporta `git_apply_dirty`.
3. `apply_patch` con hunks únicos. Un hunk que coincida dos veces es error.
4. Validación de sintaxis (js/json). Si falla, revertir al contenido anterior
   (`git_syntax_revert`) y dilo en español.
5. Read-after-write. Si el hash no cuadra, revertir.

## No hacer

- No aplicar diffs binarios ni sobre symlinks.
- No salir del workspace.
- No declarar éxito sin verificación.
