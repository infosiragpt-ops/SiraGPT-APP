"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, style, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "admin-model-switch peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-zinc-200/80 p-0.5 transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-zinc-950 data-[state=unchecked]:bg-zinc-200/80 dark:data-[state=checked]:bg-zinc-50 dark:data-[state=unchecked]:bg-zinc-700/80",
      className
    )}
    style={{
      width: 36,
      height: 20,
      minWidth: 36,
      minHeight: 20,
      maxWidth: 36,
      maxHeight: 20,
      padding: 2,
      flex: "0 0 36px",
      ...style,
    }}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.16)] ring-0 transition-transform duration-150 ease-out data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:bg-zinc-100 dark:data-[state=checked]:bg-zinc-950"
      )}
      style={{ width: 16, height: 16, minWidth: 16, minHeight: 16 }}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
