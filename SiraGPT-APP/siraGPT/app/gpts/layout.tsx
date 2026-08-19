import type React from "react"

export default function GPTsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}