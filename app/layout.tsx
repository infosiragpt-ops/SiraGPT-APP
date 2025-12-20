import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context-integrated"
import { Toaster } from "@/components/ui/sonner"
import { AppWrapper } from "@/components/app-wrapper"
import 'katex/dist/katex.min.css';
import { ChatProvider } from "@/lib/chat-context-integrated"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Sira Gpt Platform",
  description: "Multi-LLM AI Platform with Text, Image, Audio & Video Generation",
  generator: 'v0.dev'
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Fallback CDN if local CSS fails */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"
          integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV"
          crossOrigin="anonymous"
        />
      </head>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <AuthProvider>
            <ChatProvider>
              <AppWrapper>
                {children}
              </AppWrapper>
            </ChatProvider>
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
//layout.tsx