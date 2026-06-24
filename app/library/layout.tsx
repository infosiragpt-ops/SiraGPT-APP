import type { CSSProperties, ReactNode } from "react"

const libraryShellStyle = {
  height: "var(--app-viewport-height, 100dvh)",
  minHeight: "var(--app-viewport-height, 100dvh)",
} satisfies CSSProperties

export default function LibraryLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="library-shell flex w-full min-w-0 flex-col overflow-hidden bg-background"
      style={libraryShellStyle}
    >
      <div
        className="library-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain"
        role="region"
        aria-label="Biblioteca de archivos"
      >
        {children}
      </div>
    </div>
  )
}
