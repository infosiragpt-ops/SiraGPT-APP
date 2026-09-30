---
name: analisis-datos
title: Análisis de datos
description: Analiza archivos CSV o Excel: perfila los datos, calcula métricas y gráficos y entrega hallazgos. Úsala al subir datos para explorar.
category: Datos y análisis
added: 2026-09-30
featured: true
---

# Análisis de datos

Convierte un archivo de datos (CSV, XLSX, TSV) en conclusiones verificables: primero
entiende los datos, después calcula con código y por último explica qué significan y
qué no se puede afirmar.

## Cuándo usar
- El usuario sube un CSV/XLSX y pide "analiza", "qué ves", "resume", "tendencias", "compara".
- Hay que responder una pregunta de negocio con una tabla de datos (ventas, encuestas,
  inventario, métricas de producto, notas, etc.).
- Se necesita un gráfico o una tabla resumen a partir de datos reales.

No usar cuando el usuario no ha compartido datos: en ese caso pide el archivo o las
cifras; nunca generes un conjunto de datos ficticio salvo que lo pida expresamente
(y entonces márcalo como datos de ejemplo).

## Procedimiento
1. **Aclara el objetivo.** Identifica la pregunta concreta. Si es ambigua, formula tu
   interpretación en una línea y continúa; pregunta solo si cambia el análisis.
2. **Carga y perfila antes de concluir.** Con la herramienta de código disponible
   (p. ej. pandas), reporta:
   - forma (filas × columnas) y hojas del libro si es XLSX;
   - tipo inferido de cada columna (numérica, categórica, fecha, texto libre, ID);
   - nulos por columna (conteo y %), duplicados exactos, valores únicos en categóricas;
   - rango, media, mediana y desviación en numéricas; detecta atípicos con IQR
     (fuera de Q1 − 1,5·IQR / Q3 + 1,5·IQR) y señala cuántos hay.
3. **Limpia de forma explícita.** Cada transformación se declara: filas eliminadas,
   formatos de fecha normalizados, separador decimal (coma vs punto), unidades,
   categorías unificadas ("Lima" / "lima "). No imputes valores sin decirlo.
4. **Declara supuestos.** Ej.: "Asumo que `monto` está en soles y sin IGV", "Asumo
   que cada fila es una transacción". Si un supuesto es crítico, pide confirmación.
5. **Calcula, no estimes.** Todas las cifras del informe salen de código ejecutado
   sobre el archivo. Si no hay entorno de código, trabaja solo con lo que se puede
   leer directamente y dilo; nunca redondees "a ojo" ni inventes totales.
6. **Analiza según la pregunta:** agregaciones (group by), variaciones % entre
   periodos, participación sobre el total, correlaciones (con la advertencia de que
   correlación no es causalidad), segmentaciones, top/bottom N.
7. **Visualiza con las herramientas de gráficos** disponibles (`create_chart`,
   `create_dashboard_html`, etc.): series temporales → línea; comparación entre
   categorías → barras ordenadas; composición con ≤6 partes → dona; distribución →
   histograma. Título descriptivo, ejes con unidades, fuente = nombre del archivo.
8. **Valida.** Comprueba que los totales cuadran con el archivo (suma de segmentos =
   total), que los porcentajes suman ~100 % y que el número de filas usado está dicho.
9. **Redacta hallazgos y límites** con el formato de salida.

## Formato de salida
```
## Resumen
2–4 frases con la respuesta directa a la pregunta.

## Los datos
- Archivo, filas × columnas, periodo cubierto.
- Calidad: nulos relevantes, duplicados, atípicos, transformaciones aplicadas.
- Supuestos.

## Hallazgos
1. **Hallazgo en una frase** — cifra que lo respalda (cálculo o columna usada).
2. ...
(tabla resumen y/o gráfico)

## Limitaciones
- Qué no se puede concluir con estos datos y por qué.

## Siguientes pasos sugeridos
- 1–3 análisis o datos adicionales que responderían lo que queda abierto.
```

## Criterios de calidad
- [ ] Se perfiló el archivo antes de dar conclusiones.
- [ ] Cada número del informe es trazable a un cálculo sobre los datos.
- [ ] Supuestos y limpiezas están escritos, no implícitos.
- [ ] Los gráficos tienen título, unidades y el tipo adecuado al dato.
- [ ] Se distingue correlación de causalidad y tendencia de ruido (n pequeño).
- [ ] Las limitaciones son específicas (no "los datos podrían tener errores").
- [ ] Las cifras usan el formato local del usuario (miles, decimales, moneda).

## Errores a evitar
- Inventar cifras, benchmarks del sector o "promedios del mercado" que no están en el archivo.
- Concluir sobre una muestra de 12 filas como si fuera representativa.
- Ignorar nulos: un promedio sobre 40 % de valores faltantes debe advertirse.
- Mezclar periodos incompletos (mes en curso) con meses cerrados sin avisarlo.
- Gráficos de pastel con 15 categorías o ejes Y truncados que exageran diferencias.
- Mostrar código extenso en la respuesta final cuando el usuario pidió conclusiones.
