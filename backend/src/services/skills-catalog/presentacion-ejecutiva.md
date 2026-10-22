---
name: presentacion-ejecutiva
title: Presentación ejecutiva
description: Estructura y redacta presentaciones ejecutivas con una idea por diapositiva y títulos que concluyen. Úsala para decks de dirección o ventas.
category: Archivos y documentos
added: 2026-09-22
---

# Presentación ejecutiva

Construye presentaciones que cuentan una historia clara a un público con poco tiempo:
el mensaje principal al inicio, una idea por diapositiva y datos que la respaldan.
Genera el archivo (PPTX u otro formato) con las herramientas de documentos disponibles.

## Cuándo usar
- Presentaciones a dirección, directorio, inversionistas, clientes o comités.
- Convertir un informe, un análisis o notas en diapositivas.
- Mejorar un deck existente (estructura, títulos, densidad de texto).

## Procedimiento
1. **Define objetivo, audiencia y duración:** qué debe pensar, sentir o decidir la
   audiencia al final; cuánto tiempo hay (regla orientativa: 1–2 minutos por diapositiva).
2. **Escribe el mensaje principal** en una frase y la estructura narrativa:
   - situación → complicación → resolución (SCR), o
   - problema → solución → beneficios → plan → petición.
3. **Guion de títulos primero:** escribe solo los títulos de todas las diapositivas.
   Cada título es una conclusión completa ("Las ventas online crecieron 18 % y ya son un
   tercio del total"), no un tema ("Ventas online"). Leídos en secuencia, los títulos
   deben contar la historia completa.
4. **Contenido de cada diapositiva:** una sola idea, con la evidencia mínima que la
   sostiene: un gráfico, una tabla corta, 3–5 viñetas breves o una cifra destacada.
   Todo dato viene del usuario o de fuentes verificadas; lo pendiente se marca `[dato]`.
5. **Elige la visualización adecuada:** evolución → línea; comparación de 2–3 opciones → `columns`;
   matriz 2×2 / FODA / priorización → `matrix`; proceso o hoja de ruta (2–6 etapas) → `steps` (`timeline`);
   composición (≤6 partes) → dona o barra apilada; cifra clave → `stat` (`{value, caption, source}`) o
   viñetas con cifra al inicio (`"35% ahorro anual"`) que se renderizan como mosaicos KPI.
   Usa `kicker` (categoría breve en mayúsculas sobre el título) y `takeaway` (barra inferior de síntesis
   ejecutiva) en las láminas clave.
6. **Estructura típica (8–12 diapositivas):** portada con `subtitle` ejecutivo · agenda (automática en 6+ láminas) ·
   contexto / diagnóstico · 3–5 diapositivas de hallazgos o propuesta alternando layouts (`stat`, `columns`,
   `matrix`, `steps`, `table`, `chart`) · plan y cronograma · riesgos · cierre (`layout: "closing"`, decisión
   solicitada / próximos pasos).
7. **Diseño:** tema coherente (`boardroom`, `consulting`, `aurora`, `editorial` o `minimal`; si el usuario
   tiene plantilla o manual de marca, úsalo sin mezclar temas), máximo dos tipografías, jerarquía clara,
   márgenes amplios, contraste suficiente, texto de cuerpo no menor a 18 pt. Si edita un deck existente,
   respeta sus layouts y haz cambios quirúrgicos.
8. **Notas del orador:** 2–4 frases por diapositiva con lo que se dirá y los datos de apoyo.
9. **Revisa:** lectura solo de títulos, coherencia de cifras entre diapositivas,
   ortografía, que cada gráfico tenga fuente y unidades.

## Formato de salida
Primero, el guion para validar (salvo que el usuario pida el archivo directamente):
```
Objetivo: ...  ·  Audiencia: ...  ·  Duración: ...
Mensaje principal: ...

| # | Título (conclusión) | Contenido / visual | Nota del orador |
```
Después de la aprobación, genera el archivo y resume: número de diapositivas, tema
usado y datos marcados como pendientes.

## Criterios de calidad
- [ ] Los títulos, leídos en orden, cuentan la historia.
- [ ] Una idea por diapositiva; ninguna con más de ~40 palabras de cuerpo.
- [ ] Cada cifra tiene fuente y es consistente en todo el deck.
- [ ] La petición o decisión aparece al inicio y al final.
- [ ] Gráficos legibles, con unidades y sin decoración innecesaria.
- [ ] Diseño consistente con la marca del usuario si la hay.

## Errores a evitar
- Diapositivas que son párrafos de un informe.
- Títulos genéricos ("Resultados", "Análisis").
- Inventar métricas, logos de clientes o testimonios.
- Efectos, animaciones o imágenes decorativas que distraen.
- Rehacer desde cero un deck que el usuario pidió solo ajustar.
