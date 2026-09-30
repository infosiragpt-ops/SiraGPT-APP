---
name: plan-proyecto
title: Plan de proyecto
description: Arma planes de proyecto con objetivos, alcance, EDT, cronograma, riesgos y responsables. Úsala al iniciar o reordenar un proyecto.
category: Productividad
added: 2026-09-22
---

# Plan de proyecto

Convierte una idea o un encargo en un plan ejecutable: qué se entrega, en qué orden,
quién lo hace, cuándo y qué puede salir mal. El plan debe servir para dirigir el
trabajo, no para archivarlo.

## Cuándo usar
- Arranque de un proyecto (interno, de cliente, académico o personal).
- Un proyecto en marcha sin orden claro, con retrasos o alcance difuso.
- Preparar un cronograma o un diagrama de Gantt.

## Procedimiento
1. **Recoge el contexto** (pregunta lo que falte): objetivo, patrocinador, fecha de
   inicio y fecha límite, presupuesto, equipo disponible con dedicación, restricciones
   y dependencias externas.
2. **Objetivo y criterios de éxito:** una frase de objetivo y 2–4 criterios medibles
   que permitan decir "terminado y bien hecho".
3. **Alcance:** entregables incluidos, exclusiones explícitas y supuestos.
4. **Estructura de desglose del trabajo (EDT):** descompone cada entregable en paquetes
   de trabajo hasta que cada tarea tenga un responsable y dure idealmente entre 1 y 10
   días laborables.
5. **Estimación:** duración por tarea con el criterio usado (histórico del usuario,
   juicio experto o estimación de tres puntos: (optimista + 4·probable + pesimista) / 6).
   Marca como supuesto toda estimación no validada por el usuario.
6. **Dependencias y secuencia:** fin-inicio por defecto; identifica la ruta crítica
   (la cadena más larga que determina la fecha final).
7. **Cronograma:** fechas reales considerando días laborables y feriados si el usuario
   indica el país; hitos al cierre de cada fase. Si hay herramienta de diagramas
   (`create_timeline`, `create_process_flow`, Mermaid `gantt`), genera la vista.
8. **Responsables:** matriz RACI para entregables clave (`create_raci_matrix` si está
   disponible).
9. **Riesgos:** probabilidad, impacto, respuesta (evitar, mitigar, transferir, aceptar),
   dueño y disparador.
10. **Gobierno y comunicación:** frecuencia de seguimiento, formato de reporte, cómo se
    aprueban cambios de alcance.
11. **Verifica viabilidad:** si la suma de trabajo supera la capacidad del equipo en el
    plazo, dilo y propón opciones (recortar alcance, mover fecha, sumar recursos).

## Formato de salida
```
# Plan de proyecto — <nombre>
## 1. Resumen (objetivo, fechas, presupuesto, patrocinador)
## 2. Criterios de éxito
## 3. Alcance (incluye / no incluye / supuestos)
## 4. EDT
## 5. Cronograma
| ID | Tarea | Responsable | Inicio | Fin | Duración | Depende de |
Hitos y ruta crítica.
## 6. Responsables (RACI)
## 7. Riesgos
| Riesgo | Prob. | Impacto | Respuesta | Dueño |
## 8. Seguimiento y control de cambios
## 9. Supuestos y datos por confirmar
```

## Criterios de calidad
- [ ] Cada entregable del alcance aparece en la EDT y en el cronograma.
- [ ] Toda tarea tiene responsable y duración.
- [ ] Las fechas son coherentes con las dependencias y la fecha límite.
- [ ] La ruta crítica está identificada.
- [ ] Los riesgos tienen respuesta y dueño, no solo descripción.
- [ ] Se advierte si el plan no es viable con los recursos dados.

## Errores a evitar
- Tareas de semanas sin descomponer ("desarrollo del sistema: 3 meses").
- Cronogramas sin holgura ni hitos intermedios.
- Asignar a una persona al 100 % en varias tareas simultáneas.
- Inventar tarifas, costos o disponibilidad del equipo.
- Omitir las exclusiones del alcance.
