import type React from "react"

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div
      className="flex w-full flex-col overflow-hidden"
      style={{ height: "var(--app-viewport-height, 100dvh)" }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        {children}
      </div>
    </div>
  )
}
