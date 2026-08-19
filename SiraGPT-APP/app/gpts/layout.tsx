import type React from "react"

export default function GPTsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // The app shell pins `.app-shell-viewport` to the visual viewport height
  // with `overflow:hidden`, and `SidebarInset` stretches to that height. But
  // the `#main-content` wrapper between the inset and this layout has no
  // explicit height, so a plain `h-full` here resolves to a percentage of an
  // auto-height parent and collapses to zero — which left the inner
  // `overflow-auto` region unbounded and clipped any content past the fold
  // (you couldn't scroll down to the "Create" action). Anchoring this layout
  // to the same viewport-height CSS var the chat surface uses gives the inner
  // scroll region a real, keyboard-aware height so the whole builder scrolls.
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