"use client"
import * as React from "react"
import { Moon, MoonStar, Sun, Monitor, Check } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

type ThemeToggleProps = {
  className?: string
}

// "Medianoche" is an OLED flavor of the dark theme, not a separate
// next-themes theme: a persisted flag + the `midnight` class next to
// `dark` (CSS scoped to `.dark.midnight`). The boot script in
// app/layout.tsx applies the class before first paint so there is no
// canvas flash on reload.
const MIDNIGHT_KEY = "sira-theme-midnight"

function readMidnightFlag(): boolean {
  try {
    return localStorage.getItem(MIDNIGHT_KEY) === "1"
  } catch {
    return false
  }
}

function applyMidnight(on: boolean) {
  try {
    if (on) localStorage.setItem(MIDNIGHT_KEY, "1")
    else localStorage.removeItem(MIDNIGHT_KEY)
  } catch { /* storage unavailable — class still applies for the session */ }
  document.documentElement.classList.toggle("midnight", on)
}

const OPTIONS = [
  { key: "light", label: "Claro", hint: "Fondo blanco clásico", icon: Sun },
  { key: "dark", label: "Oscuro", hint: "Gris profundo, bajo contraste", icon: Moon },
  { key: "midnight", label: "Medianoche", hint: "Negro puro · OLED", icon: MoonStar },
  { key: "system", label: "Sistema", hint: "Sigue tu dispositivo", icon: Monitor },
] as const

type ThemeKey = (typeof OPTIONS)[number]["key"]

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { setTheme, theme } = useTheme()
  // Hydration-safe: the selected state only renders after mount, when
  // localStorage/theme are knowable on the client.
  const [mounted, setMounted] = React.useState(false)
  const [isMidnight, setIsMidnight] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
    setIsMidnight(readMidnightFlag())
  }, [])

  const selected: ThemeKey | null = !mounted
    ? null
    : theme === "dark" && isMidnight
      ? "midnight"
      : (theme as ThemeKey) ?? null

  const pick = (key: ThemeKey) => {
    const midnight = key === "midnight"
    applyMidnight(midnight)
    setIsMidnight(midnight)
    setTheme(midnight ? "dark" : key)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Shape + hover vocabulary matches the WhatsApp + Upgrade buttons
            so the whole header feels like one icon system. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cambiar tema"
          title="Cambiar tema"
          className={cn(
            "relative h-11 w-11 rounded-full text-muted-foreground transition-all duration-fast ease-smooth",
            "hover:bg-foreground/[0.06] hover:text-foreground",
            "active:scale-[0.96]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            className,
          )}
        >
          <Sun
            className="h-[21px] w-[21px] rotate-0 scale-100 transition-transform duration-300 dark:-rotate-90 dark:scale-0"
            strokeWidth={1.75}
          />
          <Moon
            className="absolute h-[21px] w-[21px] rotate-90 scale-0 transition-transform duration-300 dark:rotate-0 dark:scale-100"
            strokeWidth={1.75}
          />
          <span className="sr-only">Cambiar tema</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="liquid-menu-surface min-w-[12.5rem]">
        {OPTIONS.map(({ key, label, hint, icon: Icon }) => {
          const active = selected === key
          return (
            <DropdownMenuItem
              key={key}
              onClick={() => pick(key)}
              className="liquid-menu-item cursor-pointer"
            >
              <div className="flex w-full items-center gap-3">
                <div className="liquid-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.05] dark:bg-foreground/[0.07]">
                  <Icon className="h-4 w-4 text-foreground/75" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className={cn("liquid-label text-sm", active ? "font-semibold" : "font-medium")}>
                    {label}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{hint}</div>
                </div>
                {active && <Check className="h-4 w-4 shrink-0 text-foreground/80" strokeWidth={2} />}
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
