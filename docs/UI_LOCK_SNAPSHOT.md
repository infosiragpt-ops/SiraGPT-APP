# UI Lock Snapshot

Generated: 2026-05-20T15:27:02.805Z
Base commit: 8aebd72779904c28508e05c5f44a222915a41616

This is the frozen visual-surface contract for internal backend/orchestration work. React components, visible Next.js routes, styles, Tailwind config, icons, copy, spacing, animation, and layout must remain unchanged unless the lock is intentionally regenerated in a dedicated UI change.

Requested legacy client paths:
- client/src/components: missing in this repo
- client/src/pages: missing in this repo
- client/src/app: missing in this repo

Locked actual UI paths:
- app
- components
- styles
- tailwind.config.js

```text
$ tree -L 4 -I 'node_modules|dist|.next|.turbo' client/src/components client/src/pages client/src/app app components styles tailwind.config.*
(tree binary is not installed in this environment; equivalent deterministic tree output generated locally.)

client/src/components [missing]

client/src/pages [missing]

client/src/app [missing]

app
├── admin/
│   ├── analytics/
│   │   └── page.tsx
│   ├── connections/
│   │   └── page.tsx
│   ├── database/
│   │   └── page.tsx
│   ├── health/
│   │   └── page.tsx
│   ├── invoices/
│   │   └── page.tsx
│   ├── layout.tsx
│   ├── models/
│   │   └── page.tsx
│   ├── page.tsx
│   ├── payments/
│   │   └── page.tsx
│   ├── reports/
│   │   └── page.tsx
│   ├── security/
│   │   └── page.tsx
│   ├── settings/
│   │   └── page.tsx
│   ├── status/
│   │   └── page.tsx
│   └── users/
│       ├── loading.tsx
│       └── page.tsx
├── api/
│   ├── health/
│   │   └── route.ts
│   └── ready/
│       └── route.ts
├── api.zip
├── auth/
│   ├── callback/
│   │   └── page.tsx
│   ├── login/
│   │   └── page.tsx
│   ├── page.tsx
│   └── register/
│       └── page.tsx
├── billing/
│   ├── invoices/
│   │   └── page.tsx
│   └── page.tsx
├── chat/
│   ├── layout.tsx
│   └── page.tsx
├── code/
│   ├── loading.tsx
│   └── page.tsx
├── codex/
│   └── page.tsx
├── design/
│   ├── [id]/
│   │   └── page.tsx
│   ├── loading.tsx
│   └── page.tsx
├── documents/
│   └── editor/
│       └── page.tsx
├── error.tsx
├── global-error.tsx
├── globals.css
├── gpts/
│   ├── create/
│   │   └── page.tsx
│   ├── layout.tsx
│   ├── loading.tsx
│   └── page.tsx
├── home-page.tsx
├── layout.tsx
├── library/
│   ├── loading.tsx
│   └── page.tsx
├── loading.tsx
├── not-found.tsx
├── offline/
│   └── page.tsx
├── openclaw/
│   └── native/
│       └── [[...path]]/
│           └── route.ts
├── page.tsx
├── parafraseo/
│   ├── loading.tsx
│   └── page.tsx
├── payment/
│   ├── cancel/
│   │   └── page.tsx
│   └── success/
│       └── page.tsx
├── plan/
│   ├── loading.tsx
│   └── page.tsx
├── post/
│   └── page.tsx
├── privacy-policy/
│   └── page.tsx
├── profile/
│   └── page.tsx
├── projects/
│   ├── [id]/
│   │   ├── docs/
│   │   │   └── [docId]/
│   │   ├── marco-teorico/
│   │   │   └── page.tsx
│   │   └── page.tsx
│   ├── loading.tsx
│   ├── page.tsx
│   └── share/
│       └── [shareId]/
│           └── page.tsx
├── robots.ts
├── search-brain/
│   └── page.tsx
├── settings/
│   └── page.tsx
├── share/
│   ├── [shareId]/
│   │   └── page.tsx
│   └── message/
│       └── [shareId]/
│           └── page.tsx
├── sitemap.ts
├── super-admin/
│   └── page.tsx
├── thesis/
│   └── page.tsx
├── voice/
│   └── page.tsx
└── web-vitals.ts

components
├── admin-dashboard.tsx
├── admin-sidebar.tsx
├── agentic-steps.tsx
├── analytics-dashboard.tsx
├── app-shell.tsx
├── app-sidebar.tsx
├── app-wrapper.tsx
├── artifact/
│   ├── interactive-artifact-display.tsx
│   └── InteractiveArtifact.tsx
├── auth-guard.tsx
├── AuthNavButtons.tsx
├── billing-history.tsx
├── BottomGlowBar.tsx
├── BrandCycle.tsx
├── BrandLogo.tsx
├── BrowserActivityViewer.tsx
├── chart-component.tsx
├── chat/
│   ├── ArtifactCard.tsx
│   ├── ArtifactPanel.tsx
│   ├── ChatEmptyStateHero.tsx
│   ├── ComposerInlineDisplays.tsx
│   ├── diff-block.tsx
│   └── LongOperationIndicator.tsx
├── chat-interface-enhanced.tsx
├── ChatSearchDialog.tsx
├── code/
│   ├── activity-bar.tsx
│   ├── ai-code-chat-panel.tsx
│   ├── code-workspace.tsx
│   ├── diff-view.tsx
│   ├── editor-panel.tsx
│   ├── file-tree-panel.tsx
│   ├── monaco-code-area.tsx
│   ├── search-panel.tsx
│   ├── status-bar.tsx
│   └── terminal-panel.tsx
├── code-preview.tsx
├── ComputerUseInterface.tsx
├── ComputerUseReasoning.tsx
├── connection-status.tsx
├── design/
│   ├── canvas-iframe.tsx
│   ├── chat-panel.tsx
│   ├── create-panel.tsx
│   ├── design-composer.tsx
│   └── designs-grid.tsx
├── doc/
│   └── doc-artifact-display.tsx
├── document-preview.tsx
├── download-buttons.tsx
├── download-demo.tsx
├── editor/
│   ├── tiptap-editor.tsx
│   └── toolbar.tsx
├── elevenlabs-interface.tsx
├── error-boundary.tsx
├── ExcelConnector.tsx
├── ExcelRibbon.tsx
├── ExtractedDataDownload.tsx
├── figma-diagram-component.tsx
├── file-processing-badge.tsx
├── GlobalDropRedirector.tsx
├── GmailConnectionCard.tsx
├── GoogleServicesConnectionCard.tsx
├── icon-provider.tsx
├── icons/
│   ├── agent-status-icons.tsx
│   ├── premium-card-icon.tsx
│   ├── thinking-bars-icon.tsx
│   └── whatsapp-icon.tsx
├── ImageGenerationEffect.tsx
├── impersonation-banner.tsx
├── KeyboardShortcutsModal.tsx
├── landing/
│   ├── CTASection.tsx
│   ├── FeaturesSection.tsx
│   ├── Footer.tsx
│   ├── HowItWorks.tsx
│   ├── PricingSection.tsx
│   └── TestimonialsSection.tsx
├── LanguageToggle.tsx
├── Library/
│   └── LibraryTabs.tsx
├── LiquidButton.tsx
├── loading-boundary.tsx
├── marco-teorico/
│   ├── phase-timeline.tsx
│   ├── source-card.tsx
│   └── source-chart.tsx
├── message-component.tsx
├── MessageActionRail.tsx
├── MinimalAuthLanding.tsx
├── MusicGenerationComponent.tsx
├── navigation-transition-context.tsx
├── notification-center.tsx
├── paste-preview-overlay.tsx
├── payment-methods.tsx
├── plan/
│   ├── plan-artifact-display.tsx
│   └── plan-viewer.tsx
├── plan-change-manager.tsx
├── posthog-client-init.tsx
├── presentation-view.tsx
├── ProcessingGmailCard.tsx
├── ProcessingGoogleServicesCard.tsx
├── projects/
│   ├── create-project-dialog.tsx
│   └── documents-section.tsx
├── provider-error-boundary.tsx
├── PWAInstallPrompt.tsx
├── root-providers.tsx
├── route-transition-shell.tsx
├── search-brain/
│   └── UniversalSearchPanel.tsx
├── SearchPanel.tsx
├── SearchSourceSelector.tsx
├── sentry-client-init.tsx
├── sidebar/
│   └── sidebar-folders-dropdown.tsx
├── skeleton/
│   └── skeleton-pulse.tsx
├── SlashCommandMenu.tsx
├── speech-to-text-component.tsx
├── spotify-results.tsx
├── SpotifyConnectionCard.tsx
├── subscription-manager.tsx
├── super-admin-dashboard.tsx
├── SyncfusionBannerRemover.tsx
├── TableControls.tsx
├── text-to-speech-component.tsx
├── theme-provider.tsx
├── theme-toggle.tsx
├── ThesisChatConnector.tsx
├── ThesisGenerator.tsx
├── ThesisProgressComponent.tsx
├── ThesisProgressDisplay.tsx
├── thinking-placeholder.tsx
├── ui/
│   ├── accordion.tsx
│   ├── alert-dialog.tsx
│   ├── alert.tsx
│   ├── aspect-ratio.tsx
│   ├── avatar.tsx
│   ├── badge.tsx
│   ├── breadcrumb.tsx
│   ├── button.tsx
│   ├── calendar.tsx
│   ├── card.tsx
│   ├── carousel.tsx
│   ├── chart.tsx
│   ├── checkbox.tsx
│   ├── CircularProgress.tsx
│   ├── collapsible.tsx
│   ├── command.tsx
│   ├── context-menu.tsx
│   ├── custom-code-block.tsx
│   ├── date-range-picker.tsx
│   ├── dialog.tsx
│   ├── drawer.tsx
│   ├── dropdown-menu.tsx
│   ├── form.tsx
│   ├── hover-card.tsx
│   ├── image-modal.tsx
│   ├── input-otp.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── menubar.tsx
│   ├── navigation-menu.tsx
│   ├── pagination.tsx
│   ├── popover.tsx
│   ├── progress.tsx
│   ├── radio-group.tsx
│   ├── resizable.tsx
│   ├── scroll-area.tsx
│   ├── select.tsx
│   ├── separator.tsx
│   ├── sheet.tsx
│   ├── shiki-code-view.tsx
│   ├── sidebar.tsx
│   ├── skeleton.tsx
│   ├── slider.tsx
│   ├── sonner.tsx
│   ├── switch.tsx
│   ├── table.tsx
│   ├── tabs.tsx
│   ├── textarea.tsx
│   ├── thinking-indicator.tsx
│   ├── toast.tsx
│   ├── toaster.tsx
│   ├── toggle-group.tsx
│   ├── toggle.tsx
│   ├── tooltip.tsx
│   ├── use-mobile.tsx
│   └── use-toast.ts
├── UpgradeModal.tsx
├── user-settings.tsx
├── VideoGenerationComponent.tsx
├── viewers/
│   └── UnifiedDocumentViewer.tsx
├── virtual-scroll.tsx
├── viz/
│   ├── chartjs-chart.tsx
│   ├── plotly-chart.tsx
│   ├── recharts-chart.tsx
│   └── viz-artifact-display.tsx
├── voice-controls.tsx
├── voice-selector.tsx
├── WhatsAppButton.tsx
└── WordConnector.tsx

styles
├── computer-use.css
└── globals.css

tailwind.config.js

```