---
name: documentacion-tecnica
title: Documentación técnica
description: Escribe README, guías, referencias y ADRs claros y verificables a partir del código o del sistema. Úsala al documentar un proyecto.
category: Ingeniería
added: 2026-09-22
---

# Documentación técnica

Produce documentación que permita a otra persona usar, operar o modificar un sistema
sin preguntar al autor. Cada instrucción debe poder ejecutarse tal cual está escrita.

## Cuándo usar
- Crear o mejorar un README, una guía de instalación, un manual de operación
  (runbook), la referencia de una API o un registro de decisión de arquitectura (ADR).
- Documentar código existente que el usuario comparte.

## Procedimiento
1. **Define el tipo de documento según la necesidad del lector** (marco Diátaxis):
   - **Tutorial:** aprender haciendo, paso a paso, con resultado garantizado.
   - **Guía práctica (how-to):** resolver una tarea concreta para alguien que ya sabe lo básico.
   - **Referencia:** descripción exacta y completa (parámetros, opciones, errores).
   - **Explicación:** el porqué, la arquitectura y las decisiones.
   No mezcles los cuatro en una misma sección.
2. **Identifica al lector:** desarrollador nuevo, operador, usuario de la API, auditor.
3. **Obtén la información del código o del usuario**, no la supongas: comandos reales
   (`package.json`, `Makefile`), variables de entorno usadas, versiones requeridas,
   puertos, endpoints. Lo que no se pueda verificar se marca `[confirmar]`.
4. **Estructura:** título, una frase de qué es y para qué sirve, requisitos, pasos,
   resultado esperado, problemas frecuentes.
5. **Escribe pasos ejecutables:** un comando por bloque de código, con el lenguaje
   indicado (p. ej. `bash`), el directorio desde el que se ejecuta y la salida esperada cuando
   ayude a verificar.
6. **Configuración:** tabla de variables de entorno con nombre, obligatoria/opcional,
   valor por defecto y descripción. Nunca incluyas valores reales de secretos; usa
   ejemplos como `tu_clave_aqui`.
7. **ADR:** contexto, decisión, alternativas consideradas, consecuencias, estado y fecha.
8. **Diagramas** cuando aclaren el flujo (Mermaid o `create_mermaid_diagram`).
9. **Revisa:** sigue los pasos mentalmente desde un entorno limpio; ¿falta algún
   prerrequisito? ¿Los nombres coinciden con el código?

## Formato de salida (README de referencia)
```
# <Proyecto>
Una frase: qué es y qué problema resuelve.

## Requisitos
## Instalación
## Configuración
| Variable | Obligatoria | Por defecto | Descripción |
## Uso
## Arquitectura (breve, con diagrama si aplica)
## Pruebas
## Despliegue
## Solución de problemas
| Síntoma | Causa | Solución |
## Contribuir / Licencia
```
Adapta las secciones al tipo de documento elegido; omite las que no apliquen.

## Criterios de calidad
- [ ] Cada comando es copiable y funciona en el orden indicado.
- [ ] Versiones, nombres y rutas coinciden con el código real.
- [ ] No hay secretos ni datos personales.
- [ ] El lector objetivo puede completar la tarea sin conocimiento previo no declarado.
- [ ] Frases cortas, voz activa, terminología consistente.
- [ ] Lo no verificado está marcado.

## Errores a evitar
- Documentar lo que el código debería hacer en lugar de lo que hace.
- Pasos implícitos ("configura la base de datos") sin decir cómo.
- Muros de texto sin ejemplos.
- Duplicar información que quedará desactualizada; enlazar a la fuente de verdad.
- Inventar endpoints, opciones o comandos que no existen.
