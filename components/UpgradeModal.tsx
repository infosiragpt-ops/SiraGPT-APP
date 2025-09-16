"use client"

import * as React from "react"
import { MessageSquare, Globe, ImageIcon, Mic, Video, Crown } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {toast} from "sonner"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"

type Plan = "FREE" | "BASIC" | "STANDARD" | "ENTERPRISE"

interface UpgradeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user?: any
  /**
   * Called when user clicks subscribe. If provided, must accept plan and return a Promise.
   * If omitted, modal will POST /api/payments/instant itself.
   */
  onSubscribe?: (plan: Exclude<Plan, "FREE">) => Promise<void>
  isSubscribing?: boolean
}

/** Local FeatureRow used inside modal */
function FeatureRow({ icon, title, desc, included = true }: { icon: React.ReactNode; title: string; desc: string; included?: boolean }) {
  return (
    <div className={`flex items-start gap-3 ${included ? '' : 'opacity-60'}`}>
      <div className="w-8 h-8 rounded-md bg-muted/20 flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div>
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)

  // Use auth context update helper
  const { updateUser } = useAuth()

  const currentPlan = user?.plan || "FREE"
  const apiUsage = user?.apiUsage ?? 0

  const planMeta: Record<Exclude<Plan, "FREE">, { price: number; creditsLabel: string; monthlyLimit: number }> = {
    BASIC: { price: 5, creditsLabel: "10,000 / month", monthlyLimit: 10000 },
    STANDARD: { price: 15, creditsLabel: "30,000 / month", monthlyLimit: 30000 },
    ENTERPRISE: { price: 99, creditsLabel: "10,000,000 / month", monthlyLimit: 10000000 },
  }

  const subscribe = async (plan: Exclude<Plan, "FREE">) => {
    try {
      setLoadingPlan(plan)
      if (onSubscribe) {
        await onSubscribe(plan)
      } else {
        // Default behaviour: attempt server call, fallback to local update
        const add = planMeta[plan].monthlyLimit || 0

        if (!user) {
          toast.error("Please sign in to subscribe")
          return
        }

        const payload = {
          plan,
          monthlyLimit: planMeta[plan].monthlyLimit,
          price: planMeta[plan].price,
        }

        let serverUpdatedUser: any = null
        try {
          const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
          const res = await fetch(`${apiClient.apiBaseURL}/payments/instant`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            credentials: 'include',
            body: JSON.stringify(payload),
          })

          if (res.ok) {
            const body = await res.json().catch(() => ({}))
            serverUpdatedUser = body?.user ?? null
          } else {
            const errBody = await res.json().catch(() => ({}))
            console.warn("payments/instant returned non-OK:", errBody)
          }
        } catch (err) {
          console.warn("payments/instant call failed (network or CORS):", err)
        }

        if (serverUpdatedUser) {
          updateUser(serverUpdatedUser)
        } else {
          updateUser({
            plan,
            monthlyLimit: (user?.monthlyLimit ?? 0) + add,
          })
        }
      }

      toast.success("Subscription applied")
      onOpenChange(false)
    } catch (err: any) {
      console.error("subscribe error", err)
      toast.error(err?.message || "Subscription failed")
    } finally {
      setLoadingPlan(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl w-[98%] md:w-11/12 lg:w-4/5 p-6 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Plans</DialogTitle>
        </DialogHeader>

        <div className="mt-6 flex flex-col gap-6">
          {/* Top summary row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {user ? (
                <div className="text-sm">
                  <div className="font-medium">{user?.name || "User"}</div>
                  <div className="text-xs text-muted-foreground">{user?.email || ""}</div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <div>Not signed in</div>
                    <Button size="xs" variant="ghost" onClick={() => (window.location.href = "/auth/login")}>Sign in</Button>
                  </div>
                </div>
              )}
            </div>

            <div className="text-sm text-muted-foreground">
              <div>Plan: <strong>{currentPlan}</strong></div>
              <div className="text-xs">Token usage: {apiUsage}</div>
            </div>
          </div>

          {/* Grid of plan cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* FREE */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-background/80 to-background/60 backdrop-blur-md border border-border/30 shadow-md min-h-[420px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">FREE</h3>
                  <div className="text-xs text-muted-foreground mt-1">Basic access</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">Free</div>
                  <div className="text-xs text-muted-foreground">3 calls / month</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm flex-1">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Conversational assistant" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Basic web search" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Not included" included={false} />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Not included" included={false} />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Not included" included={false} />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "FREE" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Current Plan</Button>
                ) : (
                  // Free plan is not a "subscribe" option. Show informative disabled button.
                  <Button size="sm" variant="ghost" disabled className="w-full text-muted-foreground">
                    Free (default)
                  </Button>
                )}
                <div className="text-xs text-muted-foreground text-center">
                  Free tier is the default for new users — it's not a paid subscription.
                </div>
              </div>
            </div>

            {/* BASIC */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-white/10 to-white/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">BASIC</h3>
                  <div className="text-xs text-muted-foreground mt-1">GPT, Web, Image</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$5</div>
                  <div className="text-xs text-muted-foreground">10,000 / month</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Conversational assistant" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Integrated web results" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Included" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Not included" included={false} />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Not included" included={false} />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "BASIC" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Current Plan</Button>
                ) : (
                  <Button size="sm" onClick={() => subscribe("BASIC")} disabled={isSubscribing || !!loadingPlan} className="w-full">
                    Subscribe
                  </Button>
                )}
              </div>
            </div>

            {/* STANDARD */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-primary/10 to-primary/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">STANDARD</h3>
                  <div className="text-xs text-muted-foreground mt-1 h-4">All features + ElevenLabs</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$15</div>
                  <div className="text-xs text-muted-foreground h-4">30,000 / month</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Included" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Included" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Included" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Included" included />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Included" included />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "STANDARD" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Current Plan</Button>
                ) : (
                  <Button size="sm" onClick={() => subscribe("STANDARD")} disabled={isSubscribing || !!loadingPlan} className="w-full">
                    Subscribe
                  </Button>
                )}
              </div>
            </div>

            {/* ENTERPRISE */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-amber-900/10 to-amber-900/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">ENTERPRISE</h3>
                  <div className="text-xs text-muted-foreground mt-1 h-4">All features, priority & SLAs</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$99</div>
                  <div className="text-xs text-muted-foreground h-4">10,000,000 / month</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Included" included />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Included" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Advanced audio & music" desc="Included" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Priority & SLAs" desc="Included" included />
                <FeatureRow icon={<Crown className="h-5 w-5" />} title="Unlimited calls" desc="Included" included />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "ENTERPRISE" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Current Plan</Button>
                ) : (
                  <Button size="sm" onClick={() => subscribe("ENTERPRISE")} disabled={isSubscribing || !!loadingPlan} className="w-full">
                    Subscribe
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-6">
          <div className="w-full text-xs text-muted-foreground">
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}