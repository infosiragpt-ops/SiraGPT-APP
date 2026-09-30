---
name: investigacion-academica
title: Investigación académica
description: Busca, evalúa y sintetiza literatura científica con fuentes verificables y citas correctas. Úsala para estados del arte, marcos teóricos o revisiones.
category: Investigación
added: 2026-09-30
---

# Investigación académica

Apoya trabajos académicos con literatura real y verificable: formula la pregunta,
busca en bases científicas, evalúa la calidad de las fuentes y sintetiza por temas,
citando solo lo que se ha recuperado de verdad.

## Cuándo usar
- Estado del arte, marco teórico, antecedentes o revisión de literatura.
- "Busca artículos sobre…", "qué dice la evidencia de…", "necesito fuentes para…".
- Evaluar si una afirmación tiene respaldo científico.

## Regla principal
Nunca inventes autores, títulos, revistas, años, DOI, páginas ni resultados. Toda
referencia debe provenir de una búsqueda realizada en esta conversación (herramientas
como `scientific_search` o búsqueda web) o de un documento que el usuario adjuntó. Si
no hay herramientas de búsqueda disponibles, dilo y ofrece estrategias de búsqueda y
palabras clave en lugar de referencias.

## Procedimiento
1. **Precisa la pregunta** con el usuario: tema, población o contexto, periodo, idioma,
   nivel (pregrado, maestría, doctorado), norma de citación y número aproximado de fuentes.
   Para preguntas empíricas, usa un marco como PICO (población, intervención,
   comparación, resultado) o PEO.
2. **Diseña la estrategia de búsqueda:** términos en español e inglés, sinónimos,
   operadores booleanos (`"aprendizaje autónomo" AND (universitarios OR "educación superior")`),
   rango de años y tipos de documento.
3. **Busca en varias fuentes** (bases multidisciplinarias, repositorios regionales como
   SciELO o Redalyc, preprints si procede) y registra cuántos resultados se revisaron.
4. **Criba:** relevancia por título y resumen; prioriza artículos revisados por pares,
   revisiones sistemáticas y metaanálisis; anota los preprints como tales; verifica si
   hay retractaciones o correcciones cuando la herramienta lo informe.
5. **Evalúa cada fuente:** diseño del estudio, tamaño de muestra, contexto, limitaciones
   declaradas, conflictos de interés, actualidad.
6. **Extrae** en una matriz: referencia, objetivo, método, muestra, hallazgos principales,
   limitaciones.
7. **Sintetiza por temas, no por autor:** agrupa coincidencias, contradicciones y vacíos
   de conocimiento. Cada afirmación lleva su cita.
8. **Cita con la norma pedida** (APA 7 por defecto; ver la skill «Citas y referencias APA 7»).
   Solo aparecen en la lista de referencias las obras citadas en el texto.
9. **Declara límites:** bases consultadas, fechas de búsqueda, sesgos posibles (idioma,
   acceso abierto) y qué no se pudo verificar.

## Formato de salida
```
## Pregunta y alcance
## Estrategia de búsqueda
Fuentes consultadas, términos, filtros, fecha de búsqueda, resultados revisados.

## Síntesis
### Tema 1: <nombre>
Texto con citas (Autor, año).
### Tema 2: ...
### Vacíos y contradicciones

## Matriz de evidencia
| Referencia | Método | Muestra/contexto | Hallazgo principal | Limitaciones |

## Referencias
Lista en la norma pedida, con DOI o URL.

## Limitaciones de esta revisión
```

## Criterios de calidad
- [ ] Cada referencia fue recuperada en esta conversación o proviene de un adjunto.
- [ ] Cada afirmación relevante tiene cita, y cada cita tiene su referencia.
- [ ] Se distingue evidencia fuerte (revisiones, ensayos) de débil (opinión, casos).
- [ ] Se indican preprints, retractaciones y fuentes no revisadas por pares.
- [ ] La síntesis compara fuentes, no las resume una por una.
- [ ] La estrategia de búsqueda es reproducible.

## Errores a evitar
- Referencias plausibles pero inexistentes o con DOI incorrecto.
- Atribuir a un artículo conclusiones que no están en su resumen o texto.
- Generalizar resultados de un contexto a otro sin advertirlo.
- Usar solo fuentes que confirman la hipótesis del usuario.
- Redactar el trabajo completo como si fuera del usuario sin indicar que debe revisarlo
  y cumplir las normas de integridad académica de su institución.
