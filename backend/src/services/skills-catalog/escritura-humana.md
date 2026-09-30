---
name: escritura-humana
title: Escritura natural
description: Reescribe textos para que suenen naturales y propios, sin muletillas ni estructura robótica. Úsala para pulir borradores o textos generados.
category: Escritura
added: 2026-09-30
---

# Escritura natural

Reescribe o redacta textos con la voz de una persona real: variedad de ritmo, ideas
concretas y ningún relleno. El objetivo es la calidad y la claridad del texto, sin
alterar su significado ni los datos que contiene.

## Cuándo usar
- El usuario dice que un texto "suena a IA", "es muy robótico" o "muy genérico".
- Pulir un borrador propio (ensayo, publicación, carta, correo, descripción).
- Adaptar un texto a la voz del usuario a partir de ejemplos suyos.

## Principios
- Preserva el significado, los datos, las citas y la estructura argumental. Si algo
  es falso o dudoso, señálalo en lugar de reescribirlo con más seguridad.
- La naturalidad viene de ser concreto y específico, no de añadir errores ni coloquialismos.
- En trabajos académicos o evaluados, recuerda que el usuario es responsable de cumplir
  las normas de su institución sobre el uso de IA; no prometas evadir detectores.

## Procedimiento
1. **Identifica el registro y la audiencia** (académico, profesional, divulgativo,
   personal) y el idioma/variante (español de España, de México, rioplatense…). Si el
   usuario comparte textos suyos, extrae rasgos de su voz: longitud de frase, grado de
   formalidad, uso de primera persona, vocabulario habitual.
2. **Detecta rasgos artificiales**, por ejemplo:
   - conectores en serie: "Además", "Asimismo", "Cabe destacar que", "En conclusión",
     "Es importante mencionar que", "En el mundo actual";
   - grandilocuencia vacía: "fascinante", "crucial", "un sinfín de", "sumergirse en",
     "desempeña un papel fundamental", "en constante evolución";
   - tríadas automáticas (tres adjetivos o tres ejemplos siempre);
   - frases de igual longitud y párrafos con la misma forma (idea → explicación → cierre);
   - abuso de rayas, dos puntos y negritas; listas donde bastaba un párrafo;
   - conclusiones que repiten la introducción; preguntas retóricas de relleno;
   - calcos del inglés: "jugar un rol", "en orden a", "hacer sentido", gerundios encadenados.
3. **Reescribe:**
   - elimina el relleno y ve a la idea;
   - sustituye generalidades por detalles concretos presentes en el texto o aportados
     por el usuario (nunca inventes ejemplos, nombres ni cifras);
   - alterna frases cortas y largas; varía el inicio de las oraciones;
   - usa conectores solo cuando aportan una relación lógica real;
   - prefiere verbos precisos a sustantivos abstractos ("decidimos" mejor que
     "se tomó la decisión");
   - mantén la puntuación y la ortografía de la norma culta del español.
4. **Compara con el original:** mismo contenido, misma extensión aproximada salvo que se
   pidiera acortar, ningún dato añadido o perdido.
5. **Entrega** con el formato de salida.

## Formato de salida
```
<Texto reescrito>

---
**Cambios principales**
- <3–5 viñetas: qué patrones se quitaron y por qué>
**Para revisar**
- <afirmaciones que requieren fuente o datos que el usuario debe confirmar, si los hay>
```
Si el usuario solo quiere el texto, entrega únicamente el texto.

## Criterios de calidad
- [ ] El significado y los datos del original se conservan íntegros.
- [ ] No quedan muletillas de la lista anterior sin motivo.
- [ ] El ritmo varía; los párrafos no son todos iguales.
- [ ] El registro coincide con la audiencia y la variante del español.
- [ ] No se añadieron ejemplos, anécdotas, citas ni cifras inventadas.
- [ ] Se lee en voz alta sin tropiezos.

## Errores a evitar
- Introducir errores ortográficos o informalidad forzada para "parecer humano".
- Cambiar la tesis o suavizar/endurecer las afirmaciones del autor.
- Sustituir una muletilla por otra ("Además" → "Por otro lado" en cada párrafo).
- Alargar el texto con adornos.
- Afirmar que el texto "no será detectado" por ninguna herramienta.
