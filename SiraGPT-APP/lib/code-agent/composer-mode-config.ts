import { APPS_RUNTIME_STACK, APPS_STREAM_CONTRACT_PATHS } from "./apps-mode-contract"
import { streamOutputFormat } from "./prompts"
import type { ComposerMode } from "./types"

export const COMPOSER_MODE_LABEL: Readonly<Record<ComposerMode, string>> = {
  app: "App",
  build: "Build",
  deps: "Deps",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
  image: "Image",
}

export const COMPOSER_PLACEHOLDER: Readonly<Record<ComposerMode, string>> = {
  app: "Crea, prueba, itera…",
  build: "Pide un cambio, pega código o / para comandos",
  deps: "Instala paquetes y úsalos en el código…",
  plan: "Objetivo o plan antes de editar archivos…",
  debug: "Error, stack trace o comportamiento esperado…",
  ask: "Pregunta sobre tu app o tu código — respondo sin tocar archivos…",
  image: "Describe UI, asset o captura…",
}

export const COMPOSER_MODE_INSTRUCTION: Readonly<Record<ComposerMode, string>> = {
  app:
    "Modo App: entrega SOFTWARE FULL-STACK profesional, ejecutable en APPS y evolucionable desde este chat.\n" +
    "1) AUTONOMÍA — no hagas intake ni esperes confirmación; completa el brief con defaults razonables.\n" +
    "2) PLAN + EJECUCIÓN — inspecciona, implementa por capas, ejecuta checks, abre el preview y repara hasta quedar verde.\n" +
    `3) RUNTIME SOPORTADO — ${APPS_RUNTIME_STACK.frontend}; API ${APPS_RUNTIME_STACK.api}; persistencia ${APPS_RUNTIME_STACK.database}. Respeta el stack de un repo importado.\n` +
    "4) DATOS REALES — para una app con datos, el frontend consume /api, Express valida y SQLite persiste. No uses arrays globales como persistencia primaria.\n" +
    "5) EVIDENCIA — no declares éxito sin tipos/tests/build y un preview funcional; informa cualquier gate que no pudiste ejecutar.\n" +
    streamOutputFormat({ strictStart: false, paths: APPS_STREAM_CONTRACT_PATHS }) +
    "\n" +
    "Cierra con archivos cambiados, verificaciones observadas y 1-3 siguientes pasos opcionales.",
  build:
    "Modo Build: implementa cambios de código concretos. Si creas o modificas archivos, entrega bloques aplicables con ruta.",
  deps:
    "Modo Deps: actúa como un ingeniero de dependencias. Primero inspecciona package.json y el stack actual. Si el usuario pide instalar/agregar un paquete, actualiza package.json de forma mínima, instala con el gestor del workspace, ejecuta verificación y usa la dependencia en el código solo si el usuario lo pidió. No inventes paquetes; si un paquete requiere API key, variables o configuración externa, crea .env.example con placeholders y explica el requisito. Mantén el preview vivo funcionando.",
  plan:
    "Modo Plan: analiza primero, propone una arquitectura o pasos claros, identifica riesgos y no cambies archivos hasta que el usuario lo pida.",
  debug:
    "Modo Debug: diagnostica el error con hipótesis verificables, pide el dato mínimo faltante si hace falta y entrega un parche concreto cuando sea posible.",
  ask:
    "Modo Ask (igual que el modo Ask de Replit): responde de forma clara y directa preguntas sobre la app, el código o cómo funciona, con referencias a archivos cuando ayude. NO modifiques ni generes archivos. Si el usuario pide construir, crear o cambiar algo, explícale brevemente cómo se haría y sugiérele cambiar al modo Agent para que lo construya por él.",
  image:
    "Modo Image: ayuda a razonar sobre assets, interfaces, capturas o diseño visual. Si se requiere implementación, tradúcelo a cambios de código.",
}
