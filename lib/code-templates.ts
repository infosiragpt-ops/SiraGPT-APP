/**
 * code-templates — ready-to-preview scaffolds for the /code workspace.
 *
 * Each template is a small set of files that renders immediately in the live
 * preview, so "create software with instructions" always starts from
 * something visible that the agent can then evolve.
 */

export type CodeTemplateFile = { path: string; content: string }

export type CodeTemplate = {
  id: string
  name: string
  description: string
  /** File opened after scaffolding. */
  entry: string
  files: CodeTemplateFile[]
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mi producto</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased">
  <header class="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
    <span class="text-lg font-semibold">◆ Acme</span>
    <nav class="flex gap-6 text-sm text-zinc-400">
      <a href="#" class="hover:text-white">Producto</a>
      <a href="#" class="hover:text-white">Precios</a>
      <a href="#" class="rounded-full bg-white px-4 py-1.5 font-medium text-zinc-900">Empezar</a>
    </nav>
  </header>
  <main class="mx-auto max-w-3xl px-6 py-24 text-center">
    <p class="mb-4 inline-block rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">Nuevo · v1.0</p>
    <h1 class="text-5xl font-semibold tracking-tight">Construye más rápido<br/>con una idea clara.</h1>
    <p class="mx-auto mt-6 max-w-xl text-lg text-zinc-400">Una plantilla mínima y elegante. Pídele al agente que la convierta en lo que necesites.</p>
    <div class="mt-10 flex justify-center gap-3">
      <a href="#" class="rounded-lg bg-white px-6 py-3 font-medium text-zinc-900">Empezar gratis</a>
      <a href="#" class="rounded-lg border border-zinc-700 px-6 py-3 font-medium">Ver demo</a>
    </div>
  </main>
</body>
</html>`

const REACT_COUNTER = `import React, { useState } from "react"

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-zinc-100 flex items-center justify-center font-sans">
      <div className="rounded-3xl bg-white p-10 shadow-xl ring-1 ring-zinc-100 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-indigo-500">Contador</p>
        <div className="my-6 text-7xl font-bold tabular-nums">{count}</div>
        <div className="flex gap-3 justify-center">
          <button onClick={() => setCount((c) => c - 1)} className="h-11 w-11 rounded-full bg-zinc-100 text-xl hover:bg-zinc-200">−</button>
          <button onClick={() => setCount(0)} className="h-11 rounded-full bg-zinc-100 px-5 text-sm hover:bg-zinc-200">Reset</button>
          <button onClick={() => setCount((c) => c + 1)} className="h-11 w-11 rounded-full bg-indigo-600 text-xl text-white hover:bg-indigo-500">+</button>
        </div>
        <p className="mt-8 text-sm text-zinc-400">Pídele al chat: "haz un contador con historial".</p>
      </div>
    </div>
  )
}`

const REACT_DASHBOARD = `import React from "react"

const data = [
  { name: "Lun", value: 12 }, { name: "Mar", value: 19 }, { name: "Mié", value: 8 },
  { name: "Jue", value: 22 }, { name: "Vie", value: 17 }, { name: "Sáb", value: 28 }, { name: "Dom", value: 24 },
]

function Stat({ label, value, delta }) {
  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-100">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-emerald-600">▲ {delta}</p>
    </div>
  )
}

export default function App() {
  const { ResponsiveContainer, AreaChart, Area, XAxis, Tooltip } = Recharts
  return (
    <div className="min-h-screen bg-zinc-50 p-8 font-sans">
      <h1 className="text-xl font-semibold">Panel</h1>
      <p className="text-sm text-zinc-500">Resumen de la semana</p>
      <div className="mt-6 grid grid-cols-3 gap-4">
        <Stat label="Usuarios" value="1,284" delta="12%" />
        <Stat label="Ingresos" value="$8,420" delta="6%" />
        <Stat label="Conversión" value="3.9%" delta="0.4%" />
      </div>
      <div className="mt-4 h-64 rounded-2xl bg-white p-4 ring-1 ring-zinc-100">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="name" tickLine={false} axisLine={false} />
            <Tooltip />
            <Area type="monotone" dataKey="value" stroke="#6366f1" fill="url(#g)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}`

const REACT_TODO = `import React, { useState } from "react"

export default function App() {
  const [items, setItems] = useState([{ id: 1, text: "Probar el preview en vivo", done: true }, { id: 2, text: "Pedirle una app al agente", done: false }])
  const [text, setText] = useState("")
  const add = () => { const t = text.trim(); if (!t) return; setItems((xs) => [...xs, { id: Date.now(), text: t, done: false }]); setText("") }
  const toggle = (id) => setItems((xs) => xs.map((x) => x.id === id ? { ...x, done: !x.done } : x))
  const remaining = items.filter((x) => !x.done).length
  return (
    <div className="min-h-screen bg-zinc-50 flex items-start justify-center p-8 font-sans">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-100">
        <h1 className="text-lg font-semibold">Tareas <span className="text-sm font-normal text-zinc-400">· {remaining} pendientes</span></h1>
        <div className="mt-4 flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Nueva tarea…" className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
          <button onClick={add} className="rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500">Añadir</button>
        </div>
        <ul className="mt-4 space-y-1">
          {items.map((x) => (
            <li key={x.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50">
              <input type="checkbox" checked={x.done} onChange={() => toggle(x.id)} className="h-4 w-4 accent-indigo-600" />
              <span className={x.done ? "flex-1 text-sm text-zinc-400 line-through" : "flex-1 text-sm"}>{x.text}</span>
              <button onClick={() => setItems((xs) => xs.filter((y) => y.id !== x.id))} className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-rose-500">✕</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}`

const REACT_FORM = `import React, { useState } from "react"

export default function App() {
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({ name: "", email: "", message: "" })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-8 font-sans">
      <div className="w-full max-w-md rounded-2xl bg-zinc-900 p-7 ring-1 ring-white/10">
        <h1 className="text-xl font-semibold">Contacto</h1>
        <p className="mt-1 text-sm text-zinc-400">Te respondemos en 24h.</p>
        {sent ? (
          <div className="mt-6 rounded-lg bg-emerald-500/10 p-4 text-sm text-emerald-300">¡Gracias, {form.name || "crack"}! Mensaje enviado.</div>
        ) : (
          <form className="mt-6 space-y-3" onSubmit={(e) => { e.preventDefault(); setSent(true) }}>
            <input required value={form.name} onChange={set("name")} placeholder="Nombre" className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm outline-none ring-1 ring-white/10 focus:ring-indigo-400" />
            <input required type="email" value={form.email} onChange={set("email")} placeholder="Email" className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm outline-none ring-1 ring-white/10 focus:ring-indigo-400" />
            <textarea required value={form.message} onChange={set("message")} placeholder="Mensaje" rows={4} className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm outline-none ring-1 ring-white/10 focus:ring-indigo-400" />
            <button className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium hover:bg-indigo-500">Enviar</button>
          </form>
        )}
      </div>
    </div>
  )
}`

export const CODE_TEMPLATES: CodeTemplate[] = [
  {
    id: "landing",
    name: "Landing page (HTML + Tailwind)",
    description: "Hero minimalista listo para publicar.",
    entry: "index.html",
    files: [{ path: "index.html", content: LANDING_HTML }],
  },
  {
    id: "react-counter",
    name: "App React (contador)",
    description: "Componente React con estado y Tailwind.",
    entry: "App.tsx",
    files: [{ path: "App.tsx", content: REACT_COUNTER }],
  },
  {
    id: "dashboard",
    name: "Dashboard React (gráfica)",
    description: "Panel con KPIs y gráfica (Recharts).",
    entry: "App.tsx",
    files: [{ path: "App.tsx", content: REACT_DASHBOARD }],
  },
  {
    id: "todo",
    name: "App de tareas (React)",
    description: "Lista de tareas con estado, añadir y completar.",
    entry: "App.tsx",
    files: [{ path: "App.tsx", content: REACT_TODO }],
  },
  {
    id: "form",
    name: "Formulario de contacto (React)",
    description: "Form controlado con validación y estado enviado.",
    entry: "App.tsx",
    files: [{ path: "App.tsx", content: REACT_FORM }],
  },
]

export function getCodeTemplate(id: string): CodeTemplate | undefined {
  return CODE_TEMPLATES.find((t) => t.id === id)
}
