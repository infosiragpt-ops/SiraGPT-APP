export type OfficeTimeMode = "auto" | "day" | "night"
export type OfficeTimeOfDay = Exclude<OfficeTimeMode, "auto">
/**
 * Finer-grained lighting phase. It is always a strict refinement of
 * `OfficeTimeOfDay` — "dawn"/"dusk" only ever occur inside the daylight
 * window — so the scene can warm up the light without ever contradicting the
 * day/night structure (sky, stars, interior lamps).
 */
export type OfficeTimePhase = "dawn" | "day" | "dusk" | "night"

export const OFFICE_DAY_START_HOUR = 6
export const OFFICE_NIGHT_START_HOUR = 18
export const OFFICE_DAWN_END_HOUR = 8
export const OFFICE_DUSK_START_HOUR = 16

export function officeTimeOfDay(date = new Date()): OfficeTimeOfDay {
  const hour = date.getHours()
  return hour >= OFFICE_DAY_START_HOUR && hour < OFFICE_NIGHT_START_HOUR
    ? "day"
    : "night"
}

export function officeTimePhase(date = new Date()): OfficeTimePhase {
  if (officeTimeOfDay(date) === "night") return "night"
  const hour = date.getHours()
  if (hour < OFFICE_DAWN_END_HOUR) return "dawn"
  if (hour >= OFFICE_DUSK_START_HOUR) return "dusk"
  return "day"
}

export function resolveOfficeTimePhase(
  mode: OfficeTimeMode,
  date = new Date(),
): OfficeTimePhase {
  return mode === "auto" ? officeTimePhase(date) : mode
}

export function resolveOfficeTimeOfDay(
  mode: OfficeTimeMode,
  date = new Date(),
): OfficeTimeOfDay {
  return mode === "auto" ? officeTimeOfDay(date) : mode
}

export function nextOfficeTimeMode(mode: OfficeTimeMode): OfficeTimeMode {
  if (mode === "auto") return "day"
  if (mode === "day") return "night"
  return "auto"
}

export function officeTimeModeLabel(
  mode: OfficeTimeMode,
  resolved: OfficeTimeOfDay,
): string {
  if (mode === "auto") return resolved === "day" ? "Auto · Día" : "Auto · Noche"
  return resolved === "day" ? "Día" : "Noche"
}

const OFFICE_PHASE_LABELS: Record<OfficeTimePhase, string> = {
  dawn: "Amanecer",
  day: "Día",
  dusk: "Atardecer",
  night: "Noche",
}

export function officeTimePhaseLabel(phase: OfficeTimePhase): string {
  return OFFICE_PHASE_LABELS[phase]
}

/**
 * Header label. On "auto" it names the phase the clock resolved to, so the
 * user can see the office followed the real time of day instead of guessing.
 */
export function officeTimePhaseModeLabel(
  mode: OfficeTimeMode,
  phase: OfficeTimePhase,
): string {
  const label = OFFICE_PHASE_LABELS[phase]
  return mode === "auto" ? `Auto · ${label}` : label
}
