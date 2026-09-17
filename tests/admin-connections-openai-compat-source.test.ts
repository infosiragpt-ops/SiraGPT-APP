import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const pagePath = path.join(process.cwd(), "app", "admin", "connections", "page.tsx")
const routePath = path.join(process.cwd(), "backend", "src", "routes", "admin-connections.js")
const page = fs.readFileSync(pagePath, "utf8")
const route = fs.readFileSync(routePath, "utf8")

describe("admin connections OpenAI-compatible + Ollama", () => {
  it("explains mixing OpenAI-compatible APIs with local Ollama", () => {
    assert.match(page, /Conecte cualquier API compatible con OpenAI junto con los modelos locales de Ollama/)
    assert.match(page, /LMStudio, GroqCloud, Mistral, OpenRouter, vLLM/)
    assert.match(page, /mezclar y combinar proveedores libremente/)
    assert.match(page, /sincronizan modelos en AI Models como inactivos/)
  })

  it("offers Ollama, LM Studio, vLLM and GroqCloud as first-class picks", () => {
    assert.match(page, /\{ key: "ollama", label: "Ollama" \}/)
    assert.match(page, /\{ key: "lmstudio", label: "LMStudio" \}/)
    assert.match(page, /\{ key: "vllm", label: "vLLM" \}/)
    assert.match(page, /\{ key: "groq", label: "GroqCloud" \}/)
    assert.match(page, /ollama: \{ url: "http:\/\/127\.0\.0\.1:11434\/v1", authType: "None"/)
    assert.match(page, /lmstudio: \{ url: "http:\/\/127\.0\.0\.1:1234\/v1", authType: "None"/)
    assert.match(page, /vllm: \{ url: "http:\/\/127\.0\.0\.1:8000\/v1", authType: "Bearer"/)
  })

  it("keeps those local runtimes as known provider keys on the backend", () => {
    assert.match(route, /'ollama'/)
    assert.match(route, /'lmstudio'/)
    assert.match(route, /'vllm'/)
    assert.match(route, /ollama: 'Ollama \(local\)'/)
    assert.match(route, /lmstudio: 'LM Studio \(local\)'/)
    assert.match(route, /vllm: 'vLLM'/)
  })
})
