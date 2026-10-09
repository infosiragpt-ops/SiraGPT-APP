'use strict';

/**
 * Lexical cues that a chat turn is about scheduling: reminders, recurring
 * jobs, «/loop»-style intervals, the heartbeat, or managing existing
 * automations. Pure; shared by the tool-selector (keep the `automations`
 * tool in the per-turn subset) and the AI route (turn signal). Bilingual
 * ES/EN, accent-tolerant. Deliberately avoids the bare verb «programa»
 * (also «program» in Spanish code requests).
 */

const AUTOMATION_CUE_RE = new RegExp([
  'recu[eé]rda',
  'recordatorio',
  'av[ií]sa(?:me|le|nos)?\\b',
  'alarma',
  'cada\\s+(?:\\d+\\s*(?:min|minuto|hora|d[ií]a|semana|mes)|hora|d[ií]a|semana|mes|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|noche|tarde|fin(?:es)? de semana)',
  'todos los d[ií]as',
  'todas las (?:ma[ñn]anas|noches|tardes|semanas)',
  'diariamente|semanalmente|mensualmente|a diario',
  '\\bcron\\b',
  '/loop\\b',
  'check-?in',
  'latido|heartbeat',
  'automatizaci|autom[aá]ticamente|automation',
  'remind|\\bschedule',
  'every\\s+(?:\\d+|day|week|month|hour|morning|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend)',
  'daily|weekly|monthly|hourly',
  'program(?:a|ar|ame|ado|ada|es)\\s+(?:un|una|el|la|los|las)?\\s*(?:recordatorio|aviso|alerta|tarea|mensaje|resumen|revisi[oó]n|env[ií]o|ejecuci[oó]n|informe|reporte|chequeo)',
  'agenda(?:r|me)?\\s+(?:un|una)\\s+(?:recordatorio|aviso|alerta|tarea)',
  '(?:dentro de|en)\\s+\\d+\\s*(?:min|minuto|hora|h\\b)',
  'ma[ñn]ana a las',
  'monitorea|vigila|revisa cada|revisa (?:todos|todas)',
  'tareas? programadas?|automatizaciones',
].join('|'), 'i');

function mentionsAutomation(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return AUTOMATION_CUE_RE.test(value);
}

module.exports = { AUTOMATION_CUE_RE, mentionsAutomation };
