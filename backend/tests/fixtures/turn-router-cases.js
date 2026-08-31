'use strict';

/**
 * Small fixture for the §3 turn-router unit tests.
 * Not the 200-case golden set (AGENTS.md §19, later).
 */

module.exports = {
  greetings: ['hola', 'Hola', 'hola!', 'hi', 'hey', 'gracias', 'thanks'],
  explainCode: 'explica este código',
  ambiguous: 'haz algo con esto',
  h1Implement: 'implementa el login',
  h1Arregla: 'arregla app.py',
  h1Confirmed: {
    text: 'implementa el login',
    confirmedConstruir: true,
  },
  h2Plan: 'haz un plan para el login',
  h3MultiStep: 'primero investiga y luego compara las opciones',
  h4Image: 'una imagen de un gato',
  h1NoAsk: {
    text: 'mira app.py',
    attachments: [{ name: 'app.py', mimeType: 'text/x-python' }],
  },
  bothToggles: {
    text: 'implementa el login',
    toggleConstruir: true,
    togglePlanificar: true,
  },
  chipBeatsToggle: {
    text: 'arregla app.py',
    chip: 'image',
    toggleConstruir: true,
  },
  trivialWithAttachment: {
    text: 'hola',
    attachments: [{ name: 'nota.txt', mimeType: 'text/plain' }],
  },
  trivialWithChip: {
    text: 'hola',
    chip: 'voice',
    toggleConstruir: true,
  },
};
