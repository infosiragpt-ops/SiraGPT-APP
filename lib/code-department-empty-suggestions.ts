import { AGENT_COMPANY_DEPARTMENTS } from "./code-agent-company"

export type DepartmentEmptySuggestion = {
  id: string
  label: string
  prompt: string
}

const GENERIC: DepartmentEmptySuggestion[] = [
  {
    id: "objetivo",
    label: "Definir el objetivo de este departamento",
    prompt: "Define el objetivo de esta semana para este departamento y propón las tres primeras acciones.",
  },
  {
    id: "estado",
    label: "Revisar el estado y proponer el siguiente paso",
    prompt: "Revisa el estado actual de este departamento y propón el siguiente paso concreto.",
  },
  {
    id: "computadora",
    label: "Usar la computadora para investigar o ejecutar",
    prompt: "Usa la computadora del departamento para investigar y dejar evidencia de lo que encuentres.",
  },
]

const BY_KIND: Record<string, DepartmentEmptySuggestion[]> = {
  coordination: [
    {
      id: "prioridad",
      label: "Fijar prioridades de la empresa",
      prompt: "Fija las prioridades de la empresa para esta semana y asigna un dueño por departamento.",
    },
    {
      id: "decision",
      label: "Preparar una decisión con evidencia",
      prompt: "Prepara una decisión pendiente con opciones, riesgos y evidencia.",
    },
    {
      id: "ronda",
      label: "Pedir un reporte a cada departamento",
      prompt: "Pide un reporte breve a cada departamento: avance, bloqueo y siguiente paso.",
    },
  ],
  engineering: [
    {
      id: "construir",
      label: "Construir o corregir el producto",
      prompt: "Construye o corrige el siguiente incremento del producto y deja el preview verificable.",
    },
    {
      id: "calidad",
      label: "Correr pruebas y dejar evidencia",
      prompt: "Revisa calidad, corre pruebas y deja evidencia de lo que falló y lo que quedó verde.",
    },
    {
      id: "deuda",
      label: "Atacar un riesgo técnico",
      prompt: "Identifica un riesgo técnico y propón el cambio mínimo para reducirlo.",
    },
  ],
  research: [
    {
      id: "investigar",
      label: "Investigar con fuentes reales",
      prompt: "Investiga este tema con fuentes reales y resume hallazgos, riesgos y siguiente paso.",
    },
    {
      id: "comparar",
      label: "Comparar opciones y recomendar",
      prompt: "Compara las opciones disponibles y recomienda una con evidencia.",
    },
    {
      id: "informe",
      label: "Redactar un informe accionable",
      prompt: "Redacta un informe corto con hallazgos, implicaciones y acciones.",
    },
  ],
  external: [
    {
      id: "clientes",
      label: "Revisar clientes o conversaciones pendientes",
      prompt: "Revisa clientes o conversaciones pendientes y prepara la siguiente respuesta.",
    },
    {
      id: "campana",
      label: "Preparar una campaña o seguimiento",
      prompt: "Prepara una campaña o un seguimiento y deja el borrador listo para revisar.",
    },
    {
      id: "publicar",
      label: "Publicar solo con cuentas conectadas",
      prompt: "Prepara una publicación usando únicamente cuentas conectadas y la política de Recursos.",
    },
  ],
}

export function departmentEmptySuggestions(
  departmentId?: string | null,
  departmentName?: string | null,
): { name: string; suggestions: DepartmentEmptySuggestion[] } {
  const dept = AGENT_COMPANY_DEPARTMENTS.find((entry) => entry.id === departmentId)
  const name = String(departmentName || dept?.name || "CEO Office").trim() || "CEO Office"
  const suggestions = (dept?.kind && BY_KIND[dept.kind]) || GENERIC
  return { name, suggestions }
}
