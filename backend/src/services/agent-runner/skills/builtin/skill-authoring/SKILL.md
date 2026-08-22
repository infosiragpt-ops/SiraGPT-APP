---
name: skill-authoring
description: Use when a complex task succeeded and should become a reusable SKILL.md via skill_manage (create/patch) or /learn.
---

# skill-authoring — convertir un éxito en playbook

## Overview

Las skills son memoria procedimental: capturan *cómo* resolver un tipo de
tarea, no hechos sueltos. Este playbook dice cuándo autorar una skill
después de un trabajo complejo y verificado, y cómo usar `skill_manage`.

`/learn` no es un comando especial del runtime: es un turno normal del
AgentRunner que termina en `skill_manage` (create) o en `maybeAuthorSkill`.

## Cuándo autorar una skill

Autorá **solo** cuando se cumpla al menos una:

1. La tarea quedó **verificada** (`verified === true`: preview + inspección
   programática, `actual >= requested`, sin mentir "Validado").
2. El loop usó **5 o más** llamadas a herramientas (tarea compleja).

Y además la instrucción del usuario es **no trivial** (no "ok", "gracias",
"listo"). Si el pedido es corto o de un solo paso obvio, no crees skill.

No autorar:

- Fallos, reintentos a medias, o entregas sin evidencia.
- Duplicados de una skill integrada (`office-docs`, `web-research`, esta).
- Secretos, credenciales, PII o prompts del sistema.

## Divulgación progresiva

1. `skill_manage` action=`list` → catálogo (nombre + descripción). No vuelques cuerpos.
2. `skill_manage` action=`view` name=`…` → cuerpo de UNA skill, cuando la
   necesites para la tarea actual.
3. Recién entonces create/patch.

## Procedimiento — create

Escribe SOLO en el directorio extra del usuario
`{skillsHome}/{userId}/{name}/SKILL.md`. Nunca en `builtin/`.

```
skill_manage
  action: create
  name: mi-playbook          # [a-z0-9][a-z0-9_-]{0,63}
  description: Use when <disparador>. <qué hace en una línea>.
  body: |
    # mi-playbook
    ## Cuándo usar
    ...
    ## Pasos
    ...
    ## Verificación
    ...
```

Frontmatter agentskills.io: `name` + `description` (≤1024). Cuerpo ≤16000
caracteres. Empieza en el byte 0 con `---`.

## Procedimiento — patch

Para un arreglo chico (typo, un paso extra, un pitfall):

```
skill_manage
  action: patch
  name: mi-playbook
  old_string: texto exacto que ya está
  new_string: texto de reemplazo
```

`old_string` debe existir tal cual. Patch tampoco puede tocar builtins.

## Checklist

- [ ] Tarea verificada **o** ≥5 tool calls
- [ ] Instrucción no trivial
- [ ] Nombre válido, no choca con builtin
- [ ] Descripción dispara ("Use when…"), no narra un caso único
- [ ] Cuerpo accionable: cuándo / pasos / verificación
- [ ] Escrito en el root extra del usuario, no en builtin
