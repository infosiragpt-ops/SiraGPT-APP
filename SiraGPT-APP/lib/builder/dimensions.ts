import {
  Target,
  MonitorSmartphone,
  Boxes,
  Database,
  Palette,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { CoverageDimension } from "./intake-service"

export interface DimensionMeta {
  label: string
  short: string
  icon: LucideIcon
}

/** Display metadata for each coverage dimension — single source for the UI. */
export const DIMENSION_META: Record<CoverageDimension, DimensionMeta> = {
  purpose: { label: "Propósito", short: "Qué resuelve", icon: Target },
  platform: { label: "Plataforma", short: "Web · Móvil · Desktop", icon: MonitorSmartphone },
  coreFeatures: { label: "Funcionalidades", short: "Lo imprescindible", icon: Boxes },
  dataEntities: { label: "Datos", short: "Entidades", icon: Database },
  style: { label: "Estilo", short: "Identidad visual", icon: Palette },
  audience: { label: "Audiencia", short: "Para quién", icon: Users },
}
