export type OfficeTimeMode = "auto" | "day" | "night"
export type OfficeTimeOfDay = Exclude<OfficeTimeMode, "auto">

export const OFFICE_DAY_START_HOUR = 6
export const OFFICE_NIGHT_START_HOUR = 18

export function officeTimeOfDay(date = new Date()): OfficeTimeOfDay {
  const hour = date.getHours()
  return hour >= OFFICE_DAY_START_HOUR && hour < OFFICE_NIGHT_START_HOUR
    ? "day"
    : "night"
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
