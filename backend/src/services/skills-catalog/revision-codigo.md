---
name: revision-codigo
title: Revisión de código
description: Revisa código o diffs buscando errores, seguridad, rendimiento y mantenibilidad, con hallazgos por severidad. Úsala antes de fusionar un cambio.
category: Código
added: 2026-09-30
---

# Revisión de código

Revisa código como un revisor senior: encuentra primero lo que puede romper en
producción, justifica cada hallazgo con la línea concreta y propone la corrección.
Pocos hallazgos bien fundamentados valen más que muchas opiniones de estilo.

## Cuándo usar
- El usuario pega un archivo, un diff o un PR y pide revisión.
- Antes de fusionar un cambio o de pasar código a producción.
- Auditar un módulo por seguridad o rendimiento.

## Procedimiento
1. **Entiende la intención:** qué debe hacer el cambio (descripción del PR, issue,
   explicación del usuario). Si no se sabe, dedúcela del código y decláralo.
2. **Identifica el contexto:** lenguaje, framework, versión, si es código nuevo o una
   modificación. Si faltan partes necesarias (la función llamada, el esquema, los tests),
   pídelas o indica qué supuestos haces.
3. **Revisa en este orden de prioridad:**
   1. **Corrección:** lógica, condiciones límite (vacío, null/undefined, cero, negativos,
      desbordes), errores off-by-one, manejo de errores y promesas no esperadas
      (`await` faltante), condiciones de carrera, estado compartido, zonas horarias.
   2. **Seguridad:** inyección (SQL, comandos, plantillas), XSS, validación de entradas,
      autorización (¿se verifica que el recurso pertenece al usuario?), secretos en el
      código, SSRF, deserialización insegura, criptografía débil, datos sensibles en logs.
   3. **Datos:** migraciones reversibles, transacciones, pérdida de datos, compatibilidad
      con datos existentes.
   4. **Rendimiento:** consultas N+1, bucles con I/O, cargas completas en memoria,
      falta de paginación o de índices, trabajo repetido.
   5. **Mantenibilidad:** nombres, duplicación, funciones demasiado largas, acoplamiento,
      abstracciones innecesarias.
   6. **Pruebas:** ¿cubren el caso feliz, los bordes y los errores? ¿Qué test falta?
4. **Verifica cada hallazgo** antes de reportarlo: sigue el flujo real del dato. Si no
   puedes confirmarlo con el código visible, márcalo como "a verificar".
5. **Clasifica por severidad:**
   - **Bloqueante:** bug seguro, vulnerabilidad explotable, pérdida de datos.
   - **Importante:** bug probable en casos realistas, problema de rendimiento serio,
     falta de manejo de errores relevante.
   - **Menor:** mantenibilidad, legibilidad, pruebas adicionales recomendadas.
   - **Sugerencia:** opcional, preferencia o estilo.
6. **Propón la corrección** con un fragmento de código mínimo para bloqueantes e importantes.
7. **Emite un veredicto** final.

## Formato de salida
~~~
## Resumen
Qué hace el cambio (1–2 frases) y veredicto: Aprobar / Aprobar con cambios / Requiere cambios.

## Hallazgos
### [Bloqueante] <título> — `archivo:línea`
**Problema:** qué falla y en qué escenario.
**Corrección:**
```<lenguaje>
<código propuesto>
```
### [Importante] ...
### [Menor] ...

## Pruebas sugeridas
- Caso → resultado esperado.

## Lo que está bien
- 1–3 puntos concretos (opcional, breve).
~~~
Si no hay hallazgos relevantes, dilo claramente; no rellenes con estilo.

## Criterios de calidad
- [ ] Cada hallazgo cita archivo/línea o fragmento y describe un escenario concreto.
- [ ] Las severidades son coherentes (nada de estilo marcado como bloqueante).
- [ ] Las correcciones propuestas compilan y respetan el estilo del proyecto.
- [ ] Lo no verificable está marcado como supuesto.
- [ ] La seguridad se revisó explícitamente cuando hay entradas externas.

## Errores a evitar
- Listas largas de preferencias de formato que un linter resolvería.
- Afirmar bugs sin haber seguido el flujo del código.
- Reescribir todo el archivo cuando bastaba un cambio puntual.
- Ignorar lo que no se ve: si falta contexto, decirlo.
- Recomendar dependencias o patrones ajenos al stack del proyecto sin motivo.
