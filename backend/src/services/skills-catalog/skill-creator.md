---
name: skill-creator
title: Creador de skills
description: Te guía para crear una skill nueva: entrevista, redacta el SKILL.md, itera contigo y la guarda en tu biblioteca. Úsala para automatizar tareas.
category: Modelos y agentes de IA
added: 2026-09-30
---

# Creador de skills

Ayuda al usuario a convertir una tarea que repite en una skill reutilizable: un
SKILL.md con el procedimiento exacto, el estándar de calidad y el formato de salida,
que queda guardado en su biblioteca y se puede activar cuando quiera.

## Cuándo usar
- "Quiero crear una skill", "guarda esto como skill", "cada vez que te pida X haz Y".
- El usuario repite las mismas instrucciones largas en varios chats.
- Quiere adaptar una skill existente a su estilo o a su empresa (se crea una copia nueva).

## Procedimiento
1. **Entrevista breve.** Haz las preguntas en un solo mensaje (máximo 6) y adapta las
   siguientes a lo que ya se sepa del chat; no repreguntes lo que el usuario ya dijo:
   - ¿Qué tarea debe resolver la skill? ¿Qué resultado final espera?
   - ¿Con qué frases o situaciones debería activarse? (ej. "haz el acta", "revisa este contrato")
   - ¿Qué insumos recibirá? (texto pegado, archivo, URL, datos)
   - ¿Qué formato exacto debe tener la salida? (secciones, tabla, longitud, tono, idioma)
   - ¿Qué distingue un buen resultado de uno mediocre? ¿Qué nunca debe hacer?
   - ¿Tienes un ejemplo de entrada y de salida ideal?
2. **Si el usuario da poca información**, propone valores razonables marcados como
   supuestos y pide confirmación, en lugar de bloquear.
3. **Elige el nombre**: kebab-case, en minúsculas, que cumpla
   `^[a-z0-9][a-z0-9_-]{0,63}$` (ej. `acta-comite`, `resumen-legal`). Sin tildes ni espacios.
4. **Redacta la descripción**: una frase de 150 caracteres como máximo que diga QUÉ
   hace y CUÁNDO usarla (ej. "Redacta actas del comité con acuerdos y responsables.
   Úsala tras cada reunión semanal."). La descripción decide si la skill se activa,
   así que debe contener las palabras que el usuario usaría.
5. **Redacta el cuerpo** en markdown con estas secciones:
   - `# Título` y 1–2 frases de propósito.
   - `## Cuándo usar` (y cuándo no).
   - `## Procedimiento` con pasos numerados, concretos y verificables.
   - `## Formato de salida` con la estructura exacta (plantilla en bloque si ayuda).
   - `## Criterios de calidad` como checklist.
   - `## Errores a evitar`.
   Escribe instrucciones imperativas, no descripciones vagas ("Enumera los acuerdos con
   responsable y fecha", no "Se deben considerar los acuerdos"). Incluye el ejemplo del
   usuario si lo dio. Añade la regla de no inventar datos y de preguntar lo que falte.
6. **Muestra el borrador completo** (nombre, descripción y cuerpo) en un bloque de código
   y pregunta qué cambiar. Señala explícitamente los supuestos que hiciste.
7. **Itera** hasta que el usuario lo apruebe. Tras cada cambio, vuelve a mostrar solo las
   partes modificadas salvo que pida el texto entero.
8. **Guarda al aprobar.** Cuando el usuario confirme ("sí", "guárdala", "perfecto"), llama
   a la herramienta `save_skill` con:
   ```json
   { "name": "<nombre>", "description": "<descripción>", "body": "<cuerpo markdown>" }
   ```
   Confirma que quedó en su biblioteca (sección «Tuyos» en Ajustes → Skills) y que puede
   usarla desde «+ → Skills» o escribiendo «/» en el compositor.
9. **Si `save_skill` no está disponible o falla**, entrega el SKILL.md final completo en un
   bloque de código (frontmatter + cuerpo) y explica que puede añadirla en
   Ajustes → Skills → Añadir → Escribir instrucciones, pegando el contenido.
10. **Ofrece una prueba**: propone un caso de ejemplo para comprobar que la skill produce
    lo esperado y ajustarla si no.

## Formato de salida
Durante el borrador:
```
**Nombre:** <nombre>
**Descripción:** <descripción> (<n>/150 caracteres)

---
name: <nombre>
description: <descripción>
---

# <Título>
...
```
Seguido de: "Supuestos: ..." y "¿Qué quieres cambiar?".

## Criterios de calidad
- [ ] El nombre cumple el patrón y no coincide con una skill integrada.
- [ ] La descripción tiene ≤150 caracteres y dice qué hace y cuándo usarla.
- [ ] El procedimiento son pasos accionables, no principios generales.
- [ ] El formato de salida es lo bastante exacto para que dos ejecuciones se parezcan.
- [ ] Incluye qué hacer cuando faltan datos (preguntar, marcar supuestos).
- [ ] El cuerpo cabe en una lectura (idealmente menos de 150 líneas).
- [ ] No se guarda nada sin aprobación explícita del usuario.

## Errores a evitar
- Guardar la skill antes de que el usuario la apruebe.
- Descripciones genéricas ("Ayuda con documentos") que nunca se activan bien.
- Copiar datos personales, contraseñas o claves dentro de la skill.
- Instrucciones contradictorias o demasiado abiertas ("sé creativo" sin límites).
- Hacer 15 preguntas antes de mostrar un primer borrador.
