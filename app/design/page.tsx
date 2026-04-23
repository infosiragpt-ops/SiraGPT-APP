"use client"

/**
 * /design — Design studio landing. Two columns: create panel on the
 * left (brand header, tabs, design-system stub, footer pills) and
 * the user's designs grid on the right. Mirrors Claude Design's
 * layout 1:1 in structure; branded as siraGPT Diseño.
 */

import { CreatePanel } from "@/components/design/create-panel"
import { DesignsGrid } from "@/components/design/designs-grid"

export default function DesignLandingPage() {
  return (
    <div className="min-h-screen bg-[#FAF7F2] dark:bg-background">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 md:px-8 py-6 md:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-10">
          <CreatePanel />
          <div className="hidden lg:block w-px bg-border/50 self-stretch" />
          <DesignsGrid />
        </div>
      </div>
    </div>
  )
}
