/**
 * integration-stack — declarative manifest of every external library
 * the AI Product OS knows how to bind to, plus a factory that wires
 * the chosen vendor into each adapter.
 *
 * The manifest is the single source of truth for "which vendors are
 * available, which are bound, which are stubbed". It mirrors the
 * 8-layer table the user laid out:
 *
 *   1. Agentes y tool calling      → agent-sdk-adapter
 *   2. Orquestación avanzada       → orchestration-adapter
 *   3. RAG y conocimiento          → rag-adapter
 *   4. Procesamiento documental    → document-adapter
 *   5. Navegador y scraping        → browser-adapter
 *   6. Ejecución segura de código  → sandbox-adapter
 *   7. Conexión MCP                → mcp-gateway (already shipped)
 *   8. Evaluación y calidad        → eval-adapter
 *
 * Adapters default to a deterministic in-memory STUB so the platform
 * is fully functional out-of-the-box. The user / deploy environment
 * binds real providers via createIntegrationStack({ providers: { … } }).
 *
 * Pure JS, deterministic, zero deps.
 */

const { createAgentSdkAdapter } = require("./adapters/agent-sdk-adapter");
const { createOrchestrationAdapter } = require("./adapters/orchestration-adapter");
const { createRagAdapter } = require("./adapters/rag-adapter");
const { createDocumentAdapter } = require("./adapters/document-adapter");
const { createBrowserAdapter } = require("./adapters/browser-adapter");
const { createSandboxAdapter } = require("./adapters/sandbox-adapter");
const { createEvalAdapter } = require("./adapters/eval-adapter");
const { createMcpGateway } = require("./mcp-gateway");

const LAYERS = [
  {
    id: "agent-sdk",
    label: "Agentes y tool calling",
    description: "Crear agentes que planifican, llaman herramientas, delegan tareas y devuelven salidas estructuradas.",
    libraries: [
      { id: "openai-agents-sdk", name: "OpenAI Agents SDK", language: "TypeScript / Python", role: "agent-runtime" },
      { id: "pydantic-ai", name: "Pydantic AI", language: "Python", role: "structured-outputs" },
      { id: "semantic-kernel", name: "Semantic Kernel", language: "C# / Python / TS", role: "agent-runtime" },
    ],
  },
  {
    id: "orchestration",
    label: "Orquestación avanzada",
    description: "Flujos largos, reintentos, ejecución durable, recuperación, human-in-the-loop.",
    libraries: [
      { id: "langgraph", name: "LangGraph", language: "Python / TS", role: "graph-runtime" },
      { id: "dbos", name: "DBOS", language: "TS", role: "durable-workflow" },
      { id: "temporal", name: "Temporal", language: "Multi", role: "durable-workflow" },
    ],
  },
  {
    id: "rag",
    label: "RAG y conocimiento",
    description: "Carga, indexación y recuperación de documentos / bases / PDFs / Word / Excel / webs / archivos internos.",
    libraries: [
      { id: "llamaindex", name: "LlamaIndex", language: "Python / TS", role: "rag-framework" },
      { id: "langchain", name: "LangChain", language: "Python / TS", role: "rag-framework" },
      { id: "qdrant", name: "Qdrant", language: "Server", role: "vector-store" },
      { id: "pgvector", name: "pgvector", language: "Postgres extension", role: "vector-store" },
      { id: "weaviate", name: "Weaviate", language: "Server", role: "vector-store" },
    ],
  },
  {
    id: "document",
    label: "Procesamiento documental",
    description: "Leer y generar documentos complejos: PDF, Word, Excel, PowerPoint, tablas, OCR, fórmulas, imágenes y estructura.",
    libraries: [
      { id: "docling", name: "Docling", language: "Python", role: "doc-parser" },
      { id: "unstructured", name: "Unstructured", language: "Python", role: "doc-parser" },
      { id: "llamaparse", name: "LlamaParse", language: "Python", role: "doc-parser" },
      { id: "python-docx", name: "python-docx", language: "Python", role: "doc-generator" },
      { id: "openpyxl", name: "openpyxl", language: "Python", role: "doc-generator" },
      { id: "pptxgenjs", name: "PptxGenJS", language: "TS / JS", role: "doc-generator" },
      { id: "python-pptx", name: "python-pptx", language: "Python", role: "doc-generator" },
      { id: "reportlab", name: "ReportLab", language: "Python", role: "doc-generator" },
    ],
  },
  {
    id: "browser",
    label: "Navegador y scraping controlado",
    description: "Navegar webs, hacer clic, llenar formularios, verificar resultados y extraer información.",
    libraries: [
      { id: "playwright", name: "Playwright", language: "Multi", role: "browser-driver" },
      { id: "puppeteer", name: "Puppeteer", language: "TS / JS", role: "browser-driver" },
      { id: "browser-use", name: "Browser Use", language: "Python", role: "agent-browser" },
      { id: "browserless", name: "Browserless", language: "SaaS", role: "managed-browser" },
    ],
  },
  {
    id: "sandbox",
    label: "Ejecución segura de código",
    description: "Crear código, ejecutarlo, probarlo y generar archivos sin riesgo para el servidor.",
    libraries: [
      { id: "e2b", name: "E2B", language: "Multi", role: "managed-sandbox" },
      { id: "modal", name: "Modal", language: "Python", role: "serverless-sandbox" },
      { id: "docker", name: "Docker", language: "Multi", role: "container" },
      { id: "firecracker", name: "Firecracker", language: "Multi", role: "microvm" },
      { id: "gvisor", name: "gVisor", language: "Multi", role: "syscall-sandbox" },
      { id: "kubernetes-job", name: "Kubernetes Job", language: "Multi", role: "container-orchestrator" },
    ],
  },
  {
    id: "mcp",
    label: "Conexión con herramientas externas (MCP)",
    description: "Estándar abierto para conectar la IA con bases de datos, archivos, GitHub, calendarios, buscadores, APIs.",
    libraries: [
      { id: "mcp-gateway", name: "MCP Gateway (siraGPT)", language: "TS / JS", role: "mcp-host" },
    ],
  },
  {
    id: "eval",
    label: "Evaluación y calidad",
    description: "Medir si la IA entiende, usa herramientas correctas, no alucina, cita bien y cumple la tarea.",
    libraries: [
      { id: "ragas", name: "Ragas", language: "Python", role: "rag-eval" },
      { id: "promptfoo", name: "Promptfoo", language: "TS / JS", role: "ci-eval" },
      { id: "langsmith", name: "LangSmith", language: "Multi", role: "tracing" },
      { id: "openai-evals", name: "OpenAI Evals", language: "Python", role: "model-graded-eval" },
      { id: "opentelemetry", name: "OpenTelemetry", language: "Multi", role: "telemetry" },
    ],
  },
];

const LAYERS_BY_ID = Object.freeze(LAYERS.reduce((m, l) => { m[l.id] = l; return m; }, {}));

/**
 * createIntegrationStack — wires each adapter to a vendor.
 *
 * @param {object} args
 * @param {object} [args.providers]      — { agentSdk?, orchestration?, rag?, document?, browser?, sandbox?, eval? } concrete provider objects
 * @param {object} [args.vendors]        — { agentSdk?, orchestration?, ... } vendor labels (informational)
 * @param {object} [args.mcpAuditor]     — optional auditor passed to the MCP gateway
 * @returns {{ agentSdk, orchestration, rag, document, browser, sandbox, mcp, eval, manifest, status }}
 */
function createIntegrationStack({ providers = {}, vendors = {}, mcpAuditor = null } = {}) {
  const agentSdk = createAgentSdkAdapter({ provider: providers.agentSdk, vendor: vendors.agentSdk || "stub" });
  const orchestration = createOrchestrationAdapter({ provider: providers.orchestration, vendor: vendors.orchestration || "stub" });
  const rag = createRagAdapter({ provider: providers.rag, vendor: vendors.rag || "stub" });
  const document = createDocumentAdapter({ provider: providers.document, vendor: vendors.document || "stub" });
  const browser = createBrowserAdapter({ provider: providers.browser, vendor: vendors.browser || "stub" });
  const sandbox = createSandboxAdapter({ provider: providers.sandbox, vendor: vendors.sandbox || "stub" });
  const mcp = createMcpGateway({ auditor: mcpAuditor });
  const evals = createEvalAdapter({ provider: providers.eval, vendor: vendors.eval || "stub" });

  function status() {
    return {
      version: "1.0",
      generated_at: new Date().toISOString(),
      layers: LAYERS.map(layer => {
        const adapter = pickAdapter(layer.id, { agentSdk, orchestration, rag, document, browser, sandbox, mcp, evals });
        const isStub = !providers[adapterKey(layer.id)];
        return {
          id: layer.id,
          label: layer.label,
          description: layer.description,
          libraries: layer.libraries.map(lib => ({
            ...lib,
            bound: !isStub && adapter && adapter.vendor === lib.id,
          })),
          adapter: adapter ? {
            vendor: adapter.vendor,
            stub: isStub,
            capabilities: typeof adapter.capabilities === "function" ? adapter.capabilities() : null,
          } : null,
        };
      }),
    };
  }

  function manifest() {
    return LAYERS.map(l => ({
      ...l,
      libraries: l.libraries.map(lib => ({ ...lib })),
    }));
  }

  function integrity() {
    const issues = [];
    for (const layer of LAYERS) {
      if (!layer.id || !layer.label) issues.push(`layer missing id/label: ${JSON.stringify(layer).slice(0, 80)}`);
      if (!Array.isArray(layer.libraries) || layer.libraries.length === 0) issues.push(`${layer.id} has no libraries`);
      const seen = new Set();
      for (const lib of layer.libraries) {
        if (seen.has(lib.id)) issues.push(`${layer.id}: duplicate library id "${lib.id}"`);
        seen.add(lib.id);
      }
    }
    return { ok: issues.length === 0, issues, layer_count: LAYERS.length, library_count: LAYERS.reduce((s, l) => s + l.libraries.length, 0) };
  }

  return {
    agentSdk, orchestration, rag, document, browser, sandbox, mcp, eval: evals,
    manifest, status, integrity,
    LAYERS, LAYERS_BY_ID,
  };
}

function pickAdapter(layerId, all) {
  switch (layerId) {
    case "agent-sdk": return all.agentSdk;
    case "orchestration": return all.orchestration;
    case "rag": return all.rag;
    case "document": return all.document;
    case "browser": return all.browser;
    case "sandbox": return all.sandbox;
    case "mcp": return null; // MCP gateway doesn't expose .vendor / .capabilities the same way
    case "eval": return all.evals;
    default: return null;
  }
}

function adapterKey(layerId) {
  if (layerId === "agent-sdk") return "agentSdk";
  if (layerId === "eval") return "eval";
  return layerId;
}

module.exports = {
  createIntegrationStack,
  LAYERS,
  LAYERS_BY_ID,
};
