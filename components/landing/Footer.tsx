"use client"

import { motion } from "framer-motion"
import Link from "next/link"
import { Github, Twitter, Linkedin, Mail, ExternalLink } from "lucide-react"
import { BrandLogo } from "@/components/BrandLogo"

const footerLinks = {
  product: [
    { label: "Chat IA", href: "/chat" },
    { label: "GPTs Personalizados", href: "/gpts" },
    { label: "Proyectos", href: "/projects" },
    { label: "Design Studio", href: "/design" },
    { label: "Biblioteca", href: "/library" },
  ],
  resources: [
    { label: "Documentación", href: "#" },
    { label: "API Reference", href: "#" },
    { label: "Guías", href: "#" },
    { label: "Blog", href: "#" },
    { label: "Changelog", href: "#" },
  ],
  company: [
    { label: "Sobre nosotros", href: "#" },
    { label: "Carreras", href: "#" },
    { label: "Contacto", href: "#" },
    { label: "Partners", href: "#" },
  ],
  legal: [
    { label: "Privacidad", href: "/privacy-policy" },
    { label: "Términos", href: "#" },
    { label: "Cookies", href: "#" },
    { label: "Seguridad", href: "#" },
  ],
}

const socialLinks = [
  { icon: Twitter, href: "#", label: "Twitter" },
  { icon: Github, href: "#", label: "GitHub" },
  { icon: Linkedin, href: "#", label: "LinkedIn" },
  { icon: Mail, href: "mailto:hello@siragpt.com", label: "Email" },
]

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold tracking-wide text-foreground/90 uppercase">{title}</h4>
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.label}>
            <Link
              href={link.href}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors duration-200"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Footer() {
  return (
    <footer className="relative border-t border-border/60 bg-background">
      {/* Gradient top border */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, hsl(var(--ring)/0.5) 20%, hsl(var(--ring)/0.5) 80%, transparent 100%)",
        }}
      />

      <div className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="grid grid-cols-2 gap-8 md:grid-cols-6"
        >
          {/* Brand */}
          <div className="col-span-2">
            <BrandLogo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              La plataforma de IA más completa. Chatea, crea, diseña e investiga con los mejores modelos — todo en un solo lugar.
            </p>
            <div className="mt-6 flex items-center gap-3">
              {socialLinks.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  aria-label={social.label}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200"
                >
                  <social.icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>

          <FooterColumn title="Producto" links={footerLinks.product} />
          <FooterColumn title="Recursos" links={footerLinks.resources} />
          <FooterColumn title="Compañía" links={footerLinks.company} />
          <FooterColumn title="Legal" links={footerLinks.legal} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border/50 pt-8 md:flex-row"
        >
          <p className="text-sm text-muted-foreground" suppressHydrationWarning>
            © {new Date().getFullYear()} Sira GPT. Todos los derechos reservados.
          </p>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Todos los sistemas operativos
            </span>
          </div>
        </motion.div>
      </div>
    </footer>
  )
}
