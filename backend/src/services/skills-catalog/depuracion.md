---
name: depuracion
title: Depuración
description: Encuentra la causa raíz de errores con hipótesis y verificación, y propone el arreglo mínimo. Úsala ante un bug o un stack trace.
category: Código
added: 2026-09-22
---

# Depuración

Resuelve errores con método: reproducir, aislar, formular hipótesis, verificarlas y
corregir la causa raíz con el cambio más pequeño posible. Nunca adivinar un arreglo y
presentarlo como seguro.

## Cuándo usar
- El usuario comparte un error, un stack trace, un log o un comportamiento inesperado.
- "No funciona", "falla a veces", "funcionaba ayer", "da un resultado incorrecto".
- Tests que fallan de forma intermitente.

## Procedimiento
1. **Recoge los hechos** (pide lo que falte):
   - mensaje de error completo y stack trace (no parafraseado);
   - qué se esperaba y qué ocurre;
   - pasos para reproducir, frecuencia (siempre, a veces, solo en producción);
   - entorno: lenguaje, versiones, sistema, dependencias;
   - qué cambió recientemente (despliegue, dependencia, datos, configuración).
2. **Lee el error con atención:** tipo de excepción, primera línea del stack que
   pertenece al código del usuario (no a librerías), valores implicados.
3. **Reproduce o delimita:** si hay entorno de ejecución, reproduce el fallo con el caso
   mínimo. Si no, razona sobre el flujo del código y dilo.
4. **Formula 2–4 hipótesis ordenadas por probabilidad**, cada una con la evidencia a
   favor y la prueba que la confirmaría o descartaría (un log, un valor impreso, un test,
   una consulta).
5. **Aísla:** reduce el problema (comentar partes, entrada mínima, `git bisect` si
   "funcionaba antes", comparar entorno que funciona vs el que falla).
6. **Confirma la causa raíz** antes de arreglar. Distingue síntoma (el `TypeError`) de
   causa (el valor llega `undefined` porque la API cambió el nombre del campo).
7. **Arreglo mínimo:** corrige la causa, no el síntoma (evitar envolver en `try/catch`
   silencioso o añadir `?.` en todas partes sin entender por qué llega vacío).
8. **Verifica:** un test que falle antes del arreglo y pase después; revisa si el mismo
   patrón existe en otros lugares.
9. **Previene:** propone una validación, un log útil o un test de regresión.

Patrones frecuentes a considerar: `await` olvidado, mutación de estado compartido,
zonas horarias y formatos de fecha, codificación (UTF-8/BOM), rutas relativas y
directorio de trabajo, variables de entorno ausentes, caché obsoleta, versiones de
dependencias distintas entre entornos, condiciones de carrera, límites de memoria o
tiempo, CORS y cookies en el navegador.

## Formato de salida
```
## Diagnóstico
Causa raíz (o hipótesis principal si no está confirmada) en 1–3 frases.

## Evidencia
- Qué en el error/log/código lo indica.

## Arreglo
<código mínimo con el cambio, en bloque con lenguaje>
Por qué corrige la causa.

## Cómo verificarlo
- Pasos o test de regresión.

## Si no se resuelve
- Siguiente hipótesis y qué dato enviar para comprobarla.
```

## Criterios de calidad
- [ ] Se distingue claramente causa confirmada de hipótesis.
- [ ] El arreglo ataca la causa raíz y es el cambio mínimo.
- [ ] Hay un modo concreto de verificar que quedó resuelto.
- [ ] No se piden datos innecesarios si el error ya es evidente.
- [ ] No se exponen secretos (claves, tokens) al pedir logs: indicar que se enmascaren.

## Errores a evitar
- Proponer cinco arreglos a la vez sin saber cuál es el correcto.
- Silenciar el error en lugar de resolverlo.
- Culpar a la librería o al entorno sin evidencia.
- Reescribir el módulo entero para un bug puntual.
- Suponer versiones o configuraciones que el usuario no indicó.
