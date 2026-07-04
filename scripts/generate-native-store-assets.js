#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { chromium } = require("playwright")

const root = path.resolve(__dirname, "..")
const outputRoot = path.join(root, "docs/store-submission/assets")
const logoPath = path.join(root, "public/sira-gpt-512.png")
const logoDataUrl = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`

const assets = [
  {
    path: "android/feature-graphic.png",
    width: 1024,
    height: 500,
    html: featureGraphic,
  },
  {
    path: "android/phone-chat.png",
    width: 1080,
    height: 1920,
    html: (asset) => phoneScreen(asset, {
      eyebrow: "Chat inteligente",
      title: "Respuestas utiles para cada tarea",
      prompt: "Resume este documento y marca los pendientes",
      response: "Listo. Detecte objetivos, acuerdos y tareas con prioridad para que puedas continuar sin perder contexto.",
      cards: ["Resumen ejecutivo", "Tareas detectadas", "Siguiente accion"],
      tool: "GPT 5.5",
    }),
  },
  {
    path: "android/phone-documents.png",
    width: 1080,
    height: 1920,
    html: (asset) => phoneScreen(asset, {
      eyebrow: "Documentos",
      title: "Edita Word, PDF, Excel y presentaciones",
      prompt: "Corrige el documento y devuelveme el Word completo",
      response: "Documento actualizado. Conserve la estructura original, aplique correcciones y prepare el archivo para descarga.",
      cards: ["DOCX validado", "Vista previa", "Descarga lista"],
      tool: "Documentos",
    }),
  },
  {
    path: "ios/iphone-chat.png",
    width: 1290,
    height: 2796,
    html: (asset) => phoneScreen(asset, {
      eyebrow: "SiraGPT en iPhone",
      title: "Chat, voz y archivos en un solo lugar",
      prompt: "Ayudame a preparar la reunion de hoy",
      response: "He organizado agenda, preguntas clave y una lista de acciones para revisar antes de entrar.",
      cards: ["Agenda", "Notas", "Acciones"],
      tool: "GPT 5.5",
    }),
  },
  {
    path: "ios/iphone-documents.png",
    width: 1290,
    height: 2796,
    html: (asset) => phoneScreen(asset, {
      eyebrow: "Trabajo con archivos",
      title: "Sube un documento y recibe una version editable",
      prompt: "Agrega el anexo y manten mi formato original",
      response: "Archivo generado con el anexo insertado, formato preservado y control de descarga disponible.",
      cards: ["Anexo agregado", "Formato intacto", "Version final"],
      tool: "Documentos",
    }),
  },
  {
    path: "ios/iphone-projects.png",
    width: 1290,
    height: 2796,
    html: (asset) => phoneScreen(asset, {
      eyebrow: "APPS",
      title: "Construye proyectos con agentes",
      prompt: "Crea una app de ventas con dashboard",
      response: "Plan extendido preparado. Los agentes organizan UI, datos, preview, pruebas y entrega.",
      cards: ["Plan", "Preview", "Codigo"],
      tool: "APPS",
    }),
  },
  {
    path: "macos/desktop-chat.png",
    width: 1440,
    height: 900,
    html: (asset) => desktopScreen(asset, {
      platform: "macOS",
      title: "SiraGPT para Mac",
      subtitle: "Chat, documentos, voz y proyectos en una experiencia de escritorio.",
      selected: "Chat",
      panelTitle: "Respuesta lista",
      panelBody: "Organiza ideas, revisa archivos, crea documentos y mantiene el contexto de tu trabajo.",
    }),
  },
  {
    path: "macos/desktop-apps.png",
    width: 1440,
    height: 900,
    html: (asset) => desktopScreen(asset, {
      platform: "macOS",
      title: "APPS con agentes",
      subtitle: "Planifica, construye, prueba y previsualiza productos desde el panel de APPS.",
      selected: "APPS",
      panelTitle: "Agentes trabajando",
      panelBody: "Contexto, build, preview y debug avanzan en paralelo para entregar resultados verificables.",
    }),
  },
  {
    path: "windows/desktop-chat.png",
    width: 1440,
    height: 900,
    html: (asset) => desktopScreen(asset, {
      platform: "Windows",
      title: "SiraGPT para Windows",
      subtitle: "Una app nativa para tus flujos de productividad con IA.",
      selected: "Chat",
      panelTitle: "Asistente productivo",
      panelBody: "Redacta, resume, convierte archivos y responde con contexto de tus proyectos.",
    }),
  },
  {
    path: "windows/desktop-documents.png",
    width: 1440,
    height: 900,
    html: (asset) => desktopScreen(asset, {
      platform: "Windows",
      title: "Documentos profesionales",
      subtitle: "Trabaja con Word, PDF, Excel y presentaciones desde el chat.",
      selected: "Documentos",
      panelTitle: "Documento generado",
      panelBody: "Vista previa, validacion y descarga del archivo final en el formato solicitado.",
    }),
  },
]

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function htmlShell(asset, body, extraCss = "") {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  html, body {
    width: ${asset.width}px;
    height: ${asset.height}px;
    margin: 0;
    overflow: hidden;
    background: #ffffff;
    color: #0f172a;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body { position: relative; }
  .logo {
    width: 52px;
    height: 52px;
    border-radius: 16px;
    box-shadow: 0 14px 40px rgba(15, 23, 42, 0.12);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.78);
    box-shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
  }
  .muted { color: #64748b; }
  .accent { color: #0f766e; }
  .red { color: #ef4444; }
  ${extraCss}
</style>
</head>
<body>${body}</body>
</html>`
}

function featureGraphic(asset) {
  const body = `
<main class="feature">
  <section class="copy">
    <div class="brand"><img class="logo" src="${logoDataUrl}" alt=""> <span>SiraGPT</span></div>
    <h1>AI para chat, documentos y proyectos</h1>
    <p>Trabaja con archivos, voz, busqueda y APPS desde una experiencia nativa para Mac, Windows, iPhone y Android.</p>
    <div class="feature-row">
      <span>Documentos</span>
      <span>APPS</span>
      <span>Voz</span>
      <span>Productividad</span>
    </div>
  </section>
  <section class="device">
    <div class="window">
      <div class="traffic"><i></i><i></i><i></i></div>
      <div class="sidebar">
        <b>SiraGPT</b>
        <span>Chat</span>
        <span>Documentos</span>
        <span>APPS</span>
      </div>
      <div class="content">
        <div class="message user">Mejora este documento y devuelveme el archivo completo</div>
        <div class="message assistant">
          <strong>Documento actualizado</strong>
          <p>Formato preservado, cambios aplicados y descarga lista.</p>
        </div>
        <div class="asset-card">DOCX validado</div>
      </div>
    </div>
  </section>
</main>`

  const css = `
  .feature {
    width: 1024px;
    height: 500px;
    display: grid;
    grid-template-columns: 430px 1fr;
    gap: 34px;
    padding: 48px;
    background:
      radial-gradient(circle at 18% 22%, rgba(239, 68, 68, 0.16), transparent 28%),
      radial-gradient(circle at 88% 82%, rgba(20, 184, 166, 0.18), transparent 30%),
      linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
  }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 24px; font-weight: 800; }
  h1 { margin: 34px 0 18px; font-size: 54px; line-height: 0.98; letter-spacing: 0; }
  p { margin: 0; font-size: 20px; line-height: 1.42; color: #475569; }
  .feature-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
  .feature-row span { padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 999px; background: #fff; font-weight: 700; }
  .device { display: grid; place-items: center; }
  .window { width: 470px; height: 330px; border: 1px solid #dbe3ee; border-radius: 28px; background: #fff; box-shadow: 0 24px 80px rgba(15,23,42,.14); overflow: hidden; display: grid; grid-template-columns: 120px 1fr; position: relative; }
  .traffic { position: absolute; top: 18px; left: 18px; display: flex; gap: 7px; }
  .traffic i { width: 10px; height: 10px; border-radius: 999px; background: #ef4444; }
  .traffic i:nth-child(2) { background: #f59e0b; }
  .traffic i:nth-child(3) { background: #10b981; }
  .sidebar { padding: 52px 18px 18px; background: #f8fafc; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 16px; color: #64748b; }
  .sidebar b { color: #0f172a; }
  .content { padding: 54px 26px 24px; display: flex; flex-direction: column; gap: 14px; }
  .message { border-radius: 22px; padding: 16px 18px; font-size: 16px; line-height: 1.35; }
  .user { align-self: flex-end; max-width: 260px; background: #f1f5f9; }
  .assistant { background: #ecfeff; border: 1px solid #ccfbf1; }
  .assistant p { font-size: 15px; margin-top: 4px; }
  .asset-card { margin-top: auto; padding: 18px; border: 1px solid #e2e8f0; border-radius: 18px; font-weight: 800; }
  `

  return htmlShell(asset, body, css)
}

function phoneScreen(asset, options) {
  const safe = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, escapeHtml(value)]))
  const cards = options.cards.map((card) => `<div class="mini-card">${escapeHtml(card)}</div>`).join("")
  const body = `
<main class="phone">
  <header>
    <div class="brand"><img class="logo" src="${logoDataUrl}" alt=""><strong>SiraGPT</strong></div>
    <span class="pill">${safe.tool}</span>
  </header>
  <section class="hero">
    <p>${safe.eyebrow}</p>
    <h1>${safe.title}</h1>
  </section>
  <section class="chat">
    <div class="bubble user">${safe.prompt}</div>
    <div class="assistant-block">
      <div class="assistant-head"><img src="${logoDataUrl}" alt=""><strong>SiraGPT</strong></div>
      <p>${safe.response}</p>
      <div class="cards">${cards}</div>
    </div>
  </section>
  <section class="composer">
    <span>Preguntale a Sira GPT</span>
    <div class="actions"><b>+</b><i></i><strong>↑</strong></div>
  </section>
</main>`

  const scale = asset.width / 1080
  const css = `
  .phone {
    width: ${asset.width}px;
    height: ${asset.height}px;
    padding: ${Math.round(72 * scale)}px ${Math.round(56 * scale)}px ${Math.round(64 * scale)}px;
    background:
      radial-gradient(circle at 12% 14%, rgba(239, 68, 68, 0.12), transparent 28%),
      radial-gradient(circle at 85% 70%, rgba(20, 184, 166, 0.12), transparent 34%),
      #fff;
    display: flex;
    flex-direction: column;
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: ${Math.round(16 * scale)}px; font-size: ${Math.round(30 * scale)}px; }
  .logo { width: ${Math.round(56 * scale)}px; height: ${Math.round(56 * scale)}px; }
  .pill { padding: ${Math.round(14 * scale)}px ${Math.round(20 * scale)}px; font-size: ${Math.round(22 * scale)}px; font-weight: 800; }
  .hero { margin-top: ${Math.round(190 * scale)}px; }
  .hero p { margin: 0 0 ${Math.round(18 * scale)}px; font-size: ${Math.round(28 * scale)}px; font-weight: 800; color: #0f766e; }
  h1 { margin: 0; font-size: ${Math.round(72 * scale)}px; line-height: 1.02; letter-spacing: 0; max-width: ${Math.round(850 * scale)}px; }
  .chat { margin-top: ${Math.round(110 * scale)}px; display: flex; flex-direction: column; gap: ${Math.round(34 * scale)}px; }
  .bubble { padding: ${Math.round(28 * scale)}px ${Math.round(32 * scale)}px; border-radius: ${Math.round(34 * scale)}px; font-size: ${Math.round(32 * scale)}px; line-height: 1.35; }
  .user { max-width: ${Math.round(720 * scale)}px; align-self: flex-end; background: #f1f5f9; }
  .assistant-block { border: 1px solid #e2e8f0; border-radius: ${Math.round(42 * scale)}px; padding: ${Math.round(34 * scale)}px; box-shadow: 0 ${Math.round(20 * scale)}px ${Math.round(80 * scale)}px rgba(15, 23, 42, .08); background: rgba(255,255,255,.9); }
  .assistant-head { display: flex; align-items: center; gap: ${Math.round(14 * scale)}px; font-size: ${Math.round(28 * scale)}px; }
  .assistant-head img { width: ${Math.round(42 * scale)}px; height: ${Math.round(42 * scale)}px; border-radius: ${Math.round(12 * scale)}px; }
  .assistant-block p { margin: ${Math.round(26 * scale)}px 0 0; color: #334155; font-size: ${Math.round(30 * scale)}px; line-height: 1.45; }
  .cards { display: grid; gap: ${Math.round(18 * scale)}px; margin-top: ${Math.round(32 * scale)}px; }
  .mini-card { padding: ${Math.round(26 * scale)}px ${Math.round(28 * scale)}px; border-radius: ${Math.round(24 * scale)}px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: ${Math.round(27 * scale)}px; font-weight: 800; }
  .composer { margin-top: auto; min-height: ${Math.round(170 * scale)}px; border: 1px solid #dbe3ee; border-radius: ${Math.round(52 * scale)}px; padding: ${Math.round(28 * scale)}px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 ${Math.round(18 * scale)}px ${Math.round(70 * scale)}px rgba(15,23,42,.08); }
  .composer span { color: #94a3b8; font-size: ${Math.round(30 * scale)}px; }
  .actions { display: flex; align-items: center; justify-content: space-between; }
  .actions b, .actions strong { width: ${Math.round(62 * scale)}px; height: ${Math.round(62 * scale)}px; display: grid; place-items: center; border-radius: 999px; background: #f8fafc; font-size: ${Math.round(32 * scale)}px; }
  .actions i { width: ${Math.round(320 * scale)}px; height: ${Math.round(12 * scale)}px; border-radius: 999px; background: linear-gradient(90deg, #10b981, #0ea5e9, #ef4444); opacity: .7; }
  `

  return htmlShell(asset, body, css)
}

function desktopScreen(asset, options) {
  const safe = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, escapeHtml(value)]))
  const body = `
<main class="desktop">
  <aside>
    <div class="brand"><img class="logo" src="${logoDataUrl}" alt=""><strong>SiraGPT</strong></div>
    <nav>
      ${navItem("Chat", options.selected)}
      ${navItem("Documentos", options.selected)}
      ${navItem("APPS", options.selected)}
      ${navItem("Voz", options.selected)}
    </nav>
    <div class="account">SiraGPT ${safe.platform}</div>
  </aside>
  <section class="workspace">
    <div class="topbar">
      <span class="pill">${safe.platform}</span>
      <span>siragpt.com</span>
    </div>
    <div class="hero">
      <div>
        <p>App nativa</p>
        <h1>${safe.title}</h1>
        <h2>${safe.subtitle}</h2>
      </div>
      <div class="panel">
        <div class="panel-head">
          <img src="${logoDataUrl}" alt="">
          <div><strong>${safe.panelTitle}</strong><span>SiraGPT</span></div>
        </div>
        <p>${safe.panelBody}</p>
        <div class="progress"><i></i><i></i><i></i></div>
      </div>
    </div>
    <div class="dock">
      <span>Preguntale a Sira GPT</span>
      <b>+</b>
      <strong>Enviar</strong>
    </div>
  </section>
</main>`

  const css = `
  .desktop {
    width: ${asset.width}px;
    height: ${asset.height}px;
    display: grid;
    grid-template-columns: 272px 1fr;
    background: #ffffff;
  }
  aside { border-right: 1px solid #e2e8f0; background: #fafafa; padding: 28px 24px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 22px; }
  nav { margin-top: 54px; display: grid; gap: 12px; }
  .nav-item { padding: 16px 18px; border-radius: 18px; font-size: 17px; color: #64748b; }
  .nav-item.active { background: #0f172a; color: #fff; font-weight: 800; box-shadow: 0 18px 48px rgba(15,23,42,.16); }
  .account { margin-top: auto; padding: 16px; border: 1px solid #e2e8f0; border-radius: 18px; background: #fff; color: #475569; }
  .workspace { padding: 28px 46px 42px; background:
    radial-gradient(circle at 78% 15%, rgba(20, 184, 166, 0.12), transparent 30%),
    radial-gradient(circle at 22% 76%, rgba(239, 68, 68, 0.1), transparent 28%),
    #ffffff; display: flex; flex-direction: column; }
  .topbar { height: 54px; display: flex; align-items: center; justify-content: space-between; color: #64748b; }
  .topbar .pill { padding: 12px 18px; font-size: 15px; font-weight: 800; }
  .hero { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 420px; align-items: center; gap: 46px; }
  .hero p { margin: 0 0 14px; color: #0f766e; font-weight: 900; font-size: 18px; }
  h1 { margin: 0; font-size: 76px; line-height: 0.98; letter-spacing: 0; max-width: 650px; }
  h2 { margin: 24px 0 0; max-width: 640px; color: #475569; font-size: 27px; line-height: 1.35; font-weight: 500; }
  .panel { border: 1px solid #dbe3ee; border-radius: 32px; background: rgba(255,255,255,.88); box-shadow: 0 28px 90px rgba(15, 23, 42, .12); padding: 32px; }
  .panel-head { display: flex; align-items: center; gap: 16px; }
  .panel-head img { width: 54px; height: 54px; border-radius: 16px; }
  .panel-head div { display: grid; gap: 4px; }
  .panel-head strong { font-size: 22px; }
  .panel-head span { color: #64748b; }
  .panel p { margin: 28px 0; font-size: 22px; color: #334155; line-height: 1.45; }
  .progress { display: grid; gap: 14px; }
  .progress i { height: 14px; border-radius: 999px; background: #e2e8f0; position: relative; overflow: hidden; }
  .progress i::after { content: ""; display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #10b981, #0ea5e9); }
  .progress i:nth-child(1)::after { width: 92%; }
  .progress i:nth-child(2)::after { width: 74%; }
  .progress i:nth-child(3)::after { width: 64%; }
  .dock { min-height: 88px; border: 1px solid #dbe3ee; border-radius: 32px; background: #fff; box-shadow: 0 18px 60px rgba(15,23,42,.08); display: flex; align-items: center; gap: 16px; padding: 18px 22px; }
  .dock span { flex: 1; color: #94a3b8; font-size: 20px; }
  .dock b { width: 44px; height: 44px; border-radius: 999px; background: #f8fafc; display: grid; place-items: center; font-size: 24px; }
  .dock strong { padding: 14px 20px; border-radius: 999px; background: #0f172a; color: #fff; }
  `

  return htmlShell(asset, body, css)
}

function navItem(label, selected) {
  const active = label === selected ? " active" : ""
  return `<div class="nav-item${active}">${escapeHtml(label)}</div>`
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 1 })

  try {
    for (const asset of assets) {
      const outputPath = path.join(outputRoot, asset.path)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      await page.setViewportSize({ width: asset.width, height: asset.height })
      await page.setContent(asset.html(asset), { waitUntil: "load" })
      await page.screenshot({ path: outputPath, type: "png", fullPage: false })
      console.log(`store-asset: wrote ${path.relative(root, outputPath)} (${asset.width}x${asset.height})`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`generate-native-store-assets: ${error.message}`)
  process.exit(1)
})
