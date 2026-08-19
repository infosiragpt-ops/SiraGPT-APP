"use client"

import type React from "react"

import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="top-right"
      closeButton
      gap={6}
      offset={16}
      className="toaster group"
      toastOptions={{
        duration: 2600,
        style: {
          width: "min(260px, calc(100vw - 32px))",
        },
        classNames: {
          toast:
            "group toast group-[.toaster]:min-h-0 group-[.toaster]:rounded-[18px] group-[.toaster]:border-white/60 group-[.toaster]:bg-white/70 group-[.toaster]:px-3 group-[.toaster]:py-2 group-[.toaster]:text-[12px] group-[.toaster]:leading-snug group-[.toaster]:text-zinc-950 group-[.toaster]:shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_16px_42px_rgba(15,23,42,0.14)] group-[.toaster]:backdrop-blur-2xl dark:group-[.toaster]:border-white/10 dark:group-[.toaster]:bg-zinc-950/70 dark:group-[.toaster]:text-zinc-50",
          title: "group-[.toast]:text-[12px] group-[.toast]:font-medium group-[.toast]:leading-snug",
          description: "group-[.toast]:text-[11px] group-[.toast]:leading-snug group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:border-white/60 group-[.toast]:bg-white/75 group-[.toast]:text-zinc-600 group-[.toast]:shadow-sm group-[.toast]:backdrop-blur-xl group-[.toast]:hover:bg-white dark:group-[.toast]:border-white/10 dark:group-[.toast]:bg-white/10 dark:group-[.toast]:text-zinc-200",
          actionButton: "group-[.toast]:h-7 group-[.toast]:rounded-full group-[.toast]:bg-primary group-[.toast]:px-3 group-[.toast]:text-[11px] group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:h-7 group-[.toast]:rounded-full group-[.toast]:bg-muted group-[.toast]:px-3 group-[.toast]:text-[11px] group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
