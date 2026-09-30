---
name: prompt-engineering
title: Ingeniería de prompts
description: Diseña, mejora y prueba prompts y system prompts para modelos de IA. Úsala cuando un prompt da resultados inconsistentes o vas a crear uno.
category: Modelos y agentes de IA
added: 2026-09-22
---

# Ingeniería de prompts

Diseña prompts claros y comprobables para modelos de lenguaje, y mejora los existentes
con cambios justificados y verificados con casos de prueba.

## Cuándo usar
- Crear un system prompt para un asistente, agente o integración.
- Un prompt da respuestas inconsistentes, demasiado largas, con formato roto o que
  inventan información.
- Diseñar prompts de extracción, clasificación, resumen o generación estructurada (JSON).

## Procedimiento
1. **Entiende la tarea y el contexto de uso:** quién envía la entrada, qué modelo la
   recibe (si se sabe), qué hace el sistema con la salida (la lee una persona o la
   parsea código), volumen y tolerancia a errores.
2. **Recolecta ejemplos reales** de entradas, incluidas las difíciles (vacías, ambiguas,
   en otro idioma, maliciosas). Si no hay, pide 3–5 o propón casos marcados como supuestos.
3. **Redacta el prompt con estructura explícita:**
   - Rol y objetivo en 1–2 frases.
   - Contexto que el modelo necesita y no puede adivinar (audiencia, dominio, restricciones).
   - Instrucciones en pasos o viñetas, en forma afirmativa ("Responde en 3 viñetas")
     y explicando el porqué de las reglas importantes.
   - Formato de salida exacto; para salidas parseables, un esquema JSON y la indicación
     de responder solo con JSON válido.
   - Manejo de casos límite: qué hacer si falta información (preguntar, devolver `null`,
     decir "no consta"), si la petición está fuera de alcance.
   - Ejemplos (few-shot) variados, delimitados con etiquetas (`<ejemplo>`), que no
     sesguen hacia un único patrón.
4. **Separa datos de instrucciones:** envuelve el contenido del usuario o documentos
   en delimitadores (`<documento>…</documento>`) e indica que su contenido es información,
   no órdenes (mitiga inyección de prompts).
5. **Para razonamiento complejo**, pide pensar paso a paso antes de responder o dividir
   la tarea en varios prompts encadenados (extraer → analizar → redactar).
6. **Define casos de prueba** (5–10) con el resultado esperado o criterios de aceptación.
7. **Evalúa y ajusta:** ejecuta los casos si hay herramientas disponibles; si no, simula
   el razonamiento y marca que no se ha probado. Cambia una cosa por iteración y anota
   el efecto.
8. **Entrega la versión final** con un registro de cambios.

## Formato de salida
```
## Diagnóstico (si se mejora un prompt existente)
- Problema observado → causa probable en el prompt.

## Prompt propuesto
<bloque de código con el prompt completo>

## Por qué funciona
- Decisiones clave (3–6 viñetas).

## Casos de prueba
| # | Entrada | Resultado esperado |

## Cambios respecto a la versión anterior
- ...
```

## Criterios de calidad
- [ ] Un lector humano sin contexto entendería exactamente qué hacer.
- [ ] El formato de salida está especificado y es verificable.
- [ ] Hay instrucciones para información faltante o fuera de alcance.
- [ ] El contenido del usuario está delimitado y separado de las instrucciones.
- [ ] Los ejemplos son representativos y no contradicen las reglas.
- [ ] Existen casos de prueba, incluidos casos límite.
- [ ] No hay reglas redundantes ni contradictorias.

## Errores a evitar
- Prompts vagos ("sé útil y preciso") sin criterios concretos.
- Abusar de mayúsculas y amenazas ("NUNCA", "OBLIGATORIO") en lugar de explicar el motivo.
- Listas interminables de prohibiciones: mejor describir lo que sí se quiere.
- Afirmar que un prompt "funciona mejor" sin haberlo probado.
- Suponer capacidades del modelo (tamaño de contexto, herramientas) sin confirmarlas.
- Incluir secretos o datos personales dentro del prompt.
