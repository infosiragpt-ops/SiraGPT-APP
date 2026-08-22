---
name: cortex-recipes
description: Use when a job needs recall then implement then review — typed subagents with sliced step budgets.
---

# cortex-recipes — recall / implement / review

Playbook de SiraGPT sobre el pipeline Cortex ya existente en este árbol.
No se copió código de Letta ni VoltAgent; solo la idea de tipos de subagente.

## Cuándo usar

Tareas con más de un paso que mezclan investigación, cambio y crítica.

## Receta

1. **recall** — presupuesto corto (~4 pasos). Solo lectura: read_file,
   retrieve_memory, glob, grep. Prohibido write_file / apply_patch / bash.
2. **implement** — presupuesto medio (~12, recortado al restante del padre).
   Puede escribir y ejecutar. Cada write verifica sintaxis.
3. **review** — presupuesto corto (~6). Inspecciona entregables. No reescribe
   el archivo salvo execute_python de inspección.

## Presupuesto

El hijo hereda un slice del restante del padre. Si el padre está en 0,
`subagent_budget` detiene el spawn. No hay bucle infinito: el corte de
repetición del runner sigue vigente.

## Honestidad

Si recall no encontró evidencia, implement no inventa. Review reporta fallos
en español, nunca un "listo" de relleno.
