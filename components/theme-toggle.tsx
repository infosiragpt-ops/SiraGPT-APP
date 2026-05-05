"use client"
import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

type ThemeToggleProps = {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { setTheme, theme } = useTheme()

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
            "relative h-11 w-11 rounded-full text-muted-foreground transition-all duration-200",
            "hover:bg-foreground/[0.06] hover:text-foreground",
            "active:scale-[0.96]",
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
      <DropdownMenuContent align="end" className="min-w-[9rem] rounded-xl p-1">
        <DropdownMenuItem
          onClick={() => setTheme("light")}
          className={cn("cursor-pointer rounded-lg gap-2 text-[13px]", theme === 'light' && 'bg-muted/60 font-medium')}
        >
          <Sun className="h-4 w-4" strokeWidth={1.75} />
          <span>Claro</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("dark")}
          className={cn("cursor-pointer rounded-lg gap-2 text-[13px]", theme === 'dark' && 'bg-muted/60 font-medium')}
        >
          <Moon className="h-4 w-4" strokeWidth={1.75} />
          <span>Oscuro</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("system")}
          className={cn("cursor-pointer rounded-lg gap-2 text-[13px]", theme === 'system' && 'bg-muted/60 font-medium')}
        >
          <Monitor className="h-4 w-4" strokeWidth={1.75} />
          <span>Sistema</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
