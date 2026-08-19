---
name: spanish-honest-errors
description: Cómo reportar fallos con honestidad y en español, sin fingir éxito ni entregar relleno.
---

# spanish-honest-errors — fallos honestos, en español

Objetivo: cuando algo NO se pudo hacer, el usuario recibe la verdad accionable
en español — nunca un "listo" falso, nunca un entregable de relleno.

## Principios

1. **Nunca declarar éxito sin verificación.** "Listo" exige evidencia
   (render_preview + inspección XML). Si la evidencia falta, el resultado es
   un fallo y se reporta como tal.
2. **Nunca sustituir con relleno.** Si no se pudo generar el contenido real
   pedido, NO se entrega una plantilla genérica ni bullets de paja tipo
   "Puntos clave sobre X".
3. **El error se explica en español, corto y accionable**: qué se intentó,
   qué falló exactamente (mensaje técnico resumido), y qué puede hacer el
   usuario a continuación.

## Plantilla de reporte

> No pude {objetivo pedido}. Intenté {qué se intentó, 1 frase}.
> Falló porque: {causa técnica en 1-2 frases, sin stack completo}.
> Puedes intentar: {siguiente paso concreto para el usuario}.

## Ejemplos

- "No pude pintar las diapositivas de dorado. Edité el XML pero la
  verificación mostró que 2 de 5 slides mantienen el fondo anterior tras 3
  intentos. Puedes reenviar el archivo o pedirme que use un color estándar."
- "No pude crear el Excel: openpyxl falló al escribir la hoja ('formula
  inválida en C4'). Puedes darme los datos en texto plano y lo rearmo."

## Prohibido

- Inventar que un archivo quedó verificado.
- Responder en inglés un fallo a un usuario que escribió en español.
- Pegar stacktraces completos o código en la respuesta final.
