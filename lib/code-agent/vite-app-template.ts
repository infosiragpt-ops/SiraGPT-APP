/**
 * code-agent · deterministic `src/App.tsx` emitter for the Vite landing scaffold.
 *
 * Receives a LandingModel whose text fields are ALREADY jsStr-escaped string
 * literals (quotes included) and assembles the full single-tree landing:
 * Nav → Hero → Features → About → Testimonials → (Pricing) → Invitar → CTA →
 * Footer, with Framer Motion `useInView` reveals and the mandatory
 * «Invitar al proyecto» modal (exact copy strings per docs/code/landing-generator-prompt.md).
 *
 * Generated code deliberately avoids backticks and `${}` so these template
 * literals never need escape gymnastics. User text only ever lands as
 * `*Lit` constants (JSON string literals) rendered through `{CONST}`.
 */

import { jsStr } from "./escape"

/** Lucide icons allowed for feature cards (long-stable names only). */
export type FeatureIconName = "Sparkles" | "Shield" | "Zap" | "Star"

/** Lucide icons allowed as the niche motif (long-stable names only). */
export type NicheIconName =
  | "Coffee"
  | "UtensilsCrossed"
  | "Shirt"
  | "Dumbbell"
  | "HeartPulse"
  | "GraduationCap"
  | "CodeXml"
  | "Rocket"
  | "ShoppingBag"
  | "Sparkles"

const FEATURE_ICONS: readonly FeatureIconName[] = ["Sparkles", "Shield", "Zap", "Star"]
const NICHE_ICONS: readonly NicheIconName[] = [
  "Coffee",
  "UtensilsCrossed",
  "Shirt",
  "Dumbbell",
  "HeartPulse",
  "GraduationCap",
  "CodeXml",
  "Rocket",
  "ShoppingBag",
  "Sparkles",
]

/**
 * All `*Lit`/`*Lits` fields MUST be jsStr-escaped JS string literals
 * (including the surrounding double quotes). The template re-validates and
 * auto-repairs them defensively before splicing.
 */
export interface LandingModel {
  brandLit: string
  taglineLit: string
  descriptionLit: string
  heroBadgeLit: string
  inviteUrlLit: string
  aboutTitleLit: string
  aboutLeadLit: string
  aboutBodyLit: string
  ctaTitleLit: string
  ctaBodyLit: string
  footerNoteLit: string
  nicheIcon: NicheIconName
  features: Array<{ icon: FeatureIconName; titleLit: string; bodyLit: string }>
  testimonials: Array<{ nameLit: string; roleLit: string; quoteLit: string }>
  plans: Array<{ nameLit: string; priceLit: string; periodLit: string; perkLits: string[]; featured: boolean }>
  show: { features: boolean; about: boolean; testimonials: boolean; pricing: boolean }
}

/**
 * Defensive: guarantee a value is a SAFE double-quoted JS string literal.
 * JSON round-trip instead of a regex: JSON only admits escape sequences that
 * are also valid strict-mode JS escapes, so re-emitting via jsStr can never
 * produce a literal that breaks the generated module (e.g. `"\u12"`, `"\8"`).
 */
function asLit(value: string): string {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === "string") return jsStr(parsed)
  } catch {
    /* not a JSON string literal → repair below */
  }
  return jsStr(value)
}

function iconOr<T extends string>(name: T, allowed: readonly T[], fallback: T): T {
  return allowed.includes(name) ? name : fallback
}

export function buildAppTsx(model: LandingModel): string {
  const m = model
  const niche = iconOr(m.nicheIcon, NICHE_ICONS, "Sparkles")
  const show = m.show

  // ── compute the exact icon import list ───────────────────────────
  const icons = new Set<string>(["ArrowRight", "Check", "Copy", "Mail", "Menu", "UserPlus", "X"])
  icons.add(niche)
  if (show.features) for (const f of m.features) icons.add(iconOr(f.icon, FEATURE_ICONS, "Sparkles"))
  if (show.testimonials) icons.add("Star")
  if (show.pricing) icons.add("Check")
  const iconImport = Array.from(icons).sort().join(", ")

  // ── nav links follow the enabled sections ────────────────────────
  const navLinks: Array<[string, string]> = []
  if (show.features) navLinks.push(["#caracteristicas", "Características"])
  if (show.about) navLinks.push(["#nosotros", "Nosotros"])
  if (show.testimonials) navLinks.push(["#opiniones", "Opiniones"])
  if (show.pricing) navLinks.push(["#precios", "Precios"])
  navLinks.push(["#contacto", "Contacto"])
  const navLinksCode = navLinks.map(([href, label]) => `  { href: "${href}", label: "${label}" },`).join("\n")

  // ── data constants (user text only via *Lit) ─────────────────────
  const featuresCode = m.features
    .map(
      (f) =>
        `  { Icon: ${iconOr(f.icon, FEATURE_ICONS, "Sparkles")}, title: ${asLit(f.titleLit)}, body: ${asLit(f.bodyLit)} },`,
    )
    .join("\n")

  const testimonialsCode = m.testimonials
    .map((t) => `  { name: ${asLit(t.nameLit)}, role: ${asLit(t.roleLit)}, quote: ${asLit(t.quoteLit)} },`)
    .join("\n")

  const plansCode = m.plans
    .map(
      (p) =>
        `  { name: ${asLit(p.nameLit)}, price: ${asLit(p.priceLit)}, period: ${asLit(p.periodLit)}, featured: ${
          p.featured ? "true" : "false"
        }, perks: [${p.perkLits.map(asLit).join(", ")}] },`,
    )
    .join("\n")

  // ── assemble the generated file ───────────────────────────────────
  const parts: string[] = []

  parts.push(`import { useEffect, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { AnimatePresence, motion, useInView } from "framer-motion"
import { ${iconImport} } from "lucide-react"

const BRAND = ${asLit(m.brandLit)}
const TAGLINE = ${asLit(m.taglineLit)}
const DESCRIPTION = ${asLit(m.descriptionLit)}
const HERO_BADGE = ${asLit(m.heroBadgeLit)}
const INVITE_URL = ${asLit(m.inviteUrlLit)}

const NAV_LINKS = [
${navLinksCode}
]
`)

  if (show.features) {
    parts.push(`
const FEATURES = [
${featuresCode}
]
`)
  }

  if (show.testimonials) {
    parts.push(`
const TESTIMONIALS = [
${testimonialsCode}
]
`)
  }

  if (show.pricing) {
    parts.push(`
const PLANS = [
${plansCode}
]
`)
  }

  // Reveal — scroll-triggered entrance (Framer Motion useInView, once).
  parts.push(`
function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: "-80px" })
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.6, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}
`)

  parts.push(`
function Nav({ onInvite }: { onInvite: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-line/60 bg-bg/75 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6" aria-label="Principal">
        <a href="#inicio" className="font-display text-lg font-bold tracking-tight text-fg">
          {BRAND}
        </a>
        <div className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="text-sm text-muted transition-colors hover:text-fg">
              {link.label}
            </a>
          ))}
          <button
            type="button"
            onClick={onInvite}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]"
          >
            <UserPlus size={16} aria-hidden="true" />
            Invitar
          </button>
        </div>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line text-fg md:hidden"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </nav>
      {open && (
        <div className="border-t border-line/60 bg-bg/95 px-4 py-4 backdrop-blur-md md:hidden">
          <div className="flex flex-col gap-3">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="py-1 text-sm text-muted transition-colors hover:text-fg"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onInvite()
              }}
              className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg"
            >
              <UserPlus size={16} aria-hidden="true" />
              Invitar
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
`)

  parts.push(`
function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md" role="img" aria-label={DESCRIPTION}>
      <div
        className="absolute -left-10 -top-10 h-44 w-44 rounded-full bg-accent/25 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="absolute -bottom-12 -right-8 h-52 w-52 rounded-full bg-accent/15 blur-3xl"
        aria-hidden="true"
      />
      <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
            <${niche} size={28} aria-hidden="true" />
          </span>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">{HERO_BADGE}</span>
        </div>
        <div className="mt-8 space-y-3" aria-hidden="true">
          <div className="h-3 w-3/4 rounded-full bg-fg/15" />
          <div className="h-3 w-2/3 rounded-full bg-fg/10" />
          <div className="h-3 w-1/2 rounded-full bg-fg/10" />
        </div>
        <div className="mt-8 grid grid-cols-3 gap-3" aria-hidden="true">
          <div className="rounded-xl border border-line bg-bg/60 p-3">
            <p className="font-display text-lg font-bold text-fg">+120</p>
            <p className="mt-1 text-[11px] text-muted">clientes felices</p>
          </div>
          <div className="rounded-xl border border-line bg-bg/60 p-3">
            <p className="font-display text-lg font-bold text-fg">4.9</p>
            <p className="mt-1 text-[11px] text-muted">valoración media</p>
          </div>
          <div className="rounded-xl border border-line bg-bg/60 p-3">
            <p className="font-display text-lg font-bold text-accent">24h</p>
            <p className="mt-1 text-[11px] text-muted">respuesta</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden px-4 pb-20 pt-32 sm:px-6 sm:pt-36">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-muted">
            <${niche} size={14} aria-hidden="true" className="text-accent" />
            {HERO_BADGE}
          </span>
          <h1 className="mt-6 font-display text-[clamp(2.6rem,7vw,5rem)] font-extrabold leading-[1.04] tracking-tight text-fg">
            {TAGLINE}
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">{DESCRIPTION}</p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a
              href="#contacto"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]"
            >
              Empezar ahora
              <ArrowRight size={16} aria-hidden="true" />
            </a>
            <a
              href={NAV_LINKS[0].href}
              className="inline-flex items-center gap-2 rounded-full border border-line px-6 py-3 text-sm font-semibold text-fg transition-colors hover:border-accent hover:text-accent"
            >
              Descubrir más
            </a>
          </div>
        </Reveal>
        <Reveal delay={0.15}>
          <HeroVisual />
        </Reveal>
      </div>
    </section>
  )
}
`)

  if (show.features) {
    parts.push(`
function Features() {
  return (
    <section id="caracteristicas" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Lo que ofrecemos</p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Pensado al detalle, de principio a fin
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ Icon, title, body }, i) => (
            <Reveal key={title} delay={i * 0.08}>
              <article className="group h-full rounded-2xl border border-line bg-surface p-6 transition-all hover:-translate-y-1 hover:border-accent/50">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <h3 className="mt-5 font-display text-lg font-semibold text-fg">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
`)
  }

  if (show.about) {
    parts.push(`
function About() {
  return (
    <section id="nosotros" className="border-y border-line/60 bg-surface/50 px-4 py-20 sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Nuestra historia</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">{${asLit(m.aboutTitleLit)}}</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="font-display text-xl font-medium leading-relaxed text-fg">{${asLit(m.aboutLeadLit)}}</p>
          <p className="mt-5 text-sm leading-relaxed text-muted sm:text-base">{${asLit(m.aboutBodyLit)}}</p>
          <div className="mt-8 grid grid-cols-3 gap-6 border-t border-line pt-6">
            <div>
              <p className="font-display text-2xl font-bold text-fg">01</p>
              <p className="mt-1 text-xs text-muted">Calidad primero</p>
            </div>
            <div>
              <p className="font-display text-2xl font-bold text-fg">02</p>
              <p className="mt-1 text-xs text-muted">Cercanía real</p>
            </div>
            <div>
              <p className="font-display text-2xl font-bold text-fg">03</p>
              <p className="mt-1 text-xs text-muted">Mejora continua</p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
`)
  }

  if (show.testimonials) {
    parts.push(`
function Testimonials() {
  return (
    <section id="opiniones" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Opiniones</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Lo que dicen nuestros clientes
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <Reveal key={t.name} delay={i * 0.08}>
              <figure className="h-full rounded-2xl border border-line bg-surface p-6">
                <div className="flex gap-1 text-accent" aria-label="5 de 5 estrellas">
                  <Star size={14} aria-hidden="true" fill="currentColor" />
                  <Star size={14} aria-hidden="true" fill="currentColor" />
                  <Star size={14} aria-hidden="true" fill="currentColor" />
                  <Star size={14} aria-hidden="true" fill="currentColor" />
                  <Star size={14} aria-hidden="true" fill="currentColor" />
                </div>
                <blockquote className="mt-4 text-sm leading-relaxed text-fg">{t.quote}</blockquote>
                <figcaption className="mt-5 border-t border-line pt-4">
                  <p className="text-sm font-semibold text-fg">{t.name}</p>
                  <p className="text-xs text-muted">{t.role}</p>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
`)
  }

  if (show.pricing) {
    parts.push(`
function Pricing() {
  return (
    <section id="precios" className="border-y border-line/60 bg-surface/50 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Precios</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Planes claros, sin sorpresas
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 0.08}>
              <article
                className={
                  "h-full rounded-2xl border p-6 " +
                  (plan.featured ? "border-accent bg-surface shadow-xl" : "border-line bg-surface")
                }
              >
                <h3 className="font-display text-lg font-semibold text-fg">{plan.name}</h3>
                <p className="mt-3">
                  <span className="font-display text-3xl font-bold text-fg">{plan.price}</span>
                  <span className="ml-1 text-xs text-muted">{plan.period}</span>
                </p>
                <ul className="mt-5 space-y-2">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-2 text-sm text-muted">
                      <Check size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
                      {perk}
                    </li>
                  ))}
                </ul>
                <a
                  href="#contacto"
                  className={
                    "mt-6 inline-flex w-full items-center justify-center rounded-full px-4 py-2.5 text-sm font-semibold transition-transform hover:scale-[1.02] " +
                    (plan.featured ? "bg-accent text-bg" : "border border-line text-fg")
                  }
                >
                  Elegir plan
                </a>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
`)
  }

  parts.push(`
function InviteSection({ onInvite }: { onInvite: () => void }) {
  return (
    <section className="px-4 py-20 sm:px-6">
      <Reveal className="mx-auto max-w-4xl">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8 sm:p-12">
          <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Colaboración</p>
              <h2 className="mt-3 font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                Invita a tu equipo a este proyecto
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
                Comparte un enlace privado o envía invitaciones por correo para editar esta página en equipo.
              </p>
            </div>
            <button
              type="button"
              onClick={onInvite}
              className="inline-flex shrink-0 items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]"
            >
              <UserPlus size={16} aria-hidden="true" />
              Invitar
            </button>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [email, setEmail] = useState("")
  const [emailError, setEmailError] = useState("")
  const [sentTo, setSentTo] = useState("")

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copyLink = () => {
    // Solo confirmamos «¡Copiado!» cuando el portapapeles realmente se escribió;
    // si falla (iframe cross-origin sin permiso), seleccionamos el enlace para
    // que el usuario copie manualmente.
    const selectLink = () => {
      const el = document.getElementById("invite-link") as HTMLInputElement | null
      if (el) {
        el.focus()
        el.select()
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(INVITE_URL).then(() => setCopied(true)).catch(selectLink)
    } else {
      selectLink()
    }
  }

  const sendInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = email.trim()
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) {
      setEmailError("Introduce un correo válido")
      setSentTo("")
      return
    }
    setEmailError("")
    setSentTo(value)
    setEmail("")
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Invitar al proyecto"
            className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="flex items-start justify-between gap-4">
              <h3 className="font-display text-xl font-bold text-fg">Invitar al proyecto</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-fg"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <label htmlFor="invite-link" className="mt-6 block text-sm font-medium text-fg">
              Enlace privado para unirse
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="invite-link"
                readOnly
                value={INVITE_URL}
                onFocus={(event) => event.currentTarget.select()}
                className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm text-fg outline-none focus-visible:border-accent"
              />
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]"
              >
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? "¡Copiado!" : "Copiar"}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">Cualquier persona con el enlace tendrá acceso de edición</p>

            <div className="my-6 h-px bg-line" aria-hidden="true" />

            <form onSubmit={sendInvite} noValidate>
              <label htmlFor="invite-email" className="block text-sm font-medium text-fg">
                O invita directamente por correo
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setEmailError("")
                  }}
                  placeholder="colega@empresa.com"
                  className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm text-fg outline-none focus-visible:border-accent"
                />
                <button
                  type="submit"
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line px-3.5 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-accent hover:text-accent"
                >
                  <Mail size={15} aria-hidden="true" />
                  Invitar por correo electrónico
                </button>
              </div>
              {emailError !== "" && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                  {emailError}
                </p>
              )}
              {sentTo !== "" && (
                <p className="mt-2 text-xs text-accent" role="status">
                  {"Invitación enviada a " + sentTo + " (demo, sin envío real)"}
                </p>
              )}
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
`)

  parts.push(`
function CTASection({ onInvite }: { onInvite: () => void }) {
  return (
    <section id="contacto" className="px-4 pb-24 pt-4 sm:px-6">
      <Reveal className="mx-auto max-w-6xl">
        <div className="rounded-3xl bg-accent px-8 py-14 text-center sm:px-12">
          <h2 className="mx-auto max-w-2xl font-display text-3xl font-extrabold tracking-tight text-bg sm:text-4xl">
            {${asLit(m.ctaTitleLit)}}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-bg/80 sm:text-base">{${asLit(m.ctaBodyLit)}}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a
              href="#inicio"
              className="inline-flex items-center gap-2 rounded-full bg-bg px-6 py-3 text-sm font-semibold text-fg transition-transform hover:scale-[1.03]"
            >
              Empezar ahora
              <ArrowRight size={16} aria-hidden="true" />
            </a>
            <button
              type="button"
              onClick={onInvite}
              className="inline-flex items-center gap-2 rounded-full border border-bg/40 px-6 py-3 text-sm font-semibold text-bg transition-colors hover:border-bg"
            >
              <UserPlus size={16} aria-hidden="true" />
              Invitar al proyecto
            </button>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-line/60 px-4 py-12 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
        <div>
          <p className="font-display text-lg font-bold text-fg">{BRAND}</p>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">{${asLit(m.footerNoteLit)}}</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Pie de página">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="text-xs text-muted transition-colors hover:text-fg">
              {link.label}
            </a>
          ))}
        </nav>
      </div>
      <p className="mx-auto mt-10 max-w-6xl border-t border-line/60 pt-6 text-xs text-muted">
        {"© " + new Date().getFullYear() + " " + BRAND + ". Todos los derechos reservados."}
      </p>
    </footer>
  )
}

export default function App() {
  const [inviteOpen, setInviteOpen] = useState(false)
  const openInvite = () => setInviteOpen(true)
  return (
    <div id="inicio" className="min-h-screen bg-bg font-body text-fg antialiased">
      <Nav onInvite={openInvite} />
      <main>
        <Hero />
${[
  show.features ? "        <Features />" : null,
  show.about ? "        <About />" : null,
  show.testimonials ? "        <Testimonials />" : null,
  show.pricing ? "        <Pricing />" : null,
]
  .filter(Boolean)
  .join("\n")}
        <InviteSection onInvite={openInvite} />
        <CTASection onInvite={openInvite} />
      </main>
      <Footer />
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  )
}
`)

  return parts.join("")
}
