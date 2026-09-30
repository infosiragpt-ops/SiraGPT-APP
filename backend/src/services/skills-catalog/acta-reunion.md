---
name: acta-reunion
title: Acta de reunión
description: Convierte notas o transcripciones en actas con acuerdos, responsables, fechas y pendientes. Úsala al terminar una reunión.
category: Productividad
added: 2026-09-22
---

# Acta de reunión

Transforma notas, una transcripción o un audio transcrito en un acta clara que registre
qué se decidió, quién hace qué y para cuándo. Un acta no es un resumen de la
conversación: es un registro de acuerdos.

## Cuándo usar
- Después de una reunión, comité, directorio, junta o llamada con cliente.
- Cuando el usuario pega notas desordenadas o una transcripción y pide "el acta",
  "la minuta" o "los acuerdos".

## Procedimiento
1. **Identifica los datos generales:** nombre de la reunión, fecha, hora, lugar o
   plataforma, convocante, asistentes (con cargo si consta) y ausentes. Lo que no esté
   en el material se deja como `[por completar]`; no lo supongas.
2. **Reconstruye la agenda** a partir del material; si había agenda previa, respeta su
   orden y numeración.
3. **Por cada punto**, extrae en 2–4 líneas lo discutido (posiciones relevantes, datos
   presentados) sin transcribir diálogos.
4. **Separa con rigor tres tipos de resultado:**
   - **Acuerdo/decisión:** algo que quedó resuelto ("Se aprueba el presupuesto de …").
   - **Tarea:** acción con responsable y fecha.
   - **Pendiente:** tema abierto que requiere información o una decisión posterior.
5. **Tareas completas:** cada una con verbo de acción, responsable nominal (persona, no
   área) y fecha límite. Si el material no dice responsable o fecha, marca
   `[sin responsable]` / `[sin fecha]` y lístalo en las observaciones para confirmar.
6. **Registra votaciones** si las hubo (a favor, en contra, abstenciones) y la
   verificación de quórum en órganos formales.
7. **Redacta en tercera persona y en pasado**, tono neutral, sin juicios ("el gerente
   expresó preocupación por…", no "el gerente se molestó").
8. **Próxima reunión:** fecha, hora y temas si se acordaron.
9. **Revisa** que cada tarea mencionada en la discusión aparezca en la tabla y que no
   haya acuerdos atribuidos a quien no estuvo presente.

## Formato de salida
```
# Acta de reunión — <nombre>
**Fecha:** <dd/mm/aaaa> · **Hora:** <inicio–fin> · **Lugar/plataforma:** <...>
**Convoca:** <...> · **Redacta:** <...>
**Asistentes:** <nombre (cargo)>, ...
**Ausentes:** <...>

## Agenda
1. ...

## Desarrollo
### 1. <Punto de agenda>
Resumen de lo tratado.
**Acuerdo:** ...

## Acuerdos
| # | Acuerdo |

## Tareas
| # | Tarea | Responsable | Fecha límite | Estado |

## Pendientes
- Tema — qué falta para resolverlo.

## Próxima reunión
<fecha, hora, temas>

## Observaciones para confirmar
- Datos faltantes o ambiguos detectados.
```

## Criterios de calidad
- [ ] Todos los acuerdos son decisiones explícitas del material, no inferencias.
- [ ] Todas las tareas tienen responsable y fecha, o están marcadas para confirmar.
- [ ] Se distingue acuerdo, tarea y pendiente.
- [ ] Lenguaje neutral, tercera persona, sin opiniones.
- [ ] Fechas en formato uniforme y coherentes con la fecha de la reunión.
- [ ] Extensión razonable: una reunión de una hora cabe en una o dos páginas.

## Errores a evitar
- Inventar asistentes, fechas o responsables.
- Transcribir la conversación completa.
- Tareas sin dueño ("se revisará el contrato").
- Convertir opiniones de un participante en acuerdos del grupo.
- Omitir los temas que quedaron sin resolver.
