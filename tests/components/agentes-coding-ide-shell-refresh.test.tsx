import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CodingIdeShell } from "@/components/agentes/coding-ide-shell"

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "chat1" }),
}))

vi.mock("@/lib/codex/api/projects", async () => {
  const actual = await vi.importActual<typeof import("@/lib/codex/api/projects")>(
    "@/lib/codex/api/projects",
  )
  return {
    ...actual,
    projectsCodexApi: {
      ...actual.projectsCodexApi,
      listProjects: vi.fn(),
      getProject: vi.fn(),
      getProjectByChat: vi.fn(),
      ensureProjectForChat: vi.fn(),
      listFiles: vi.fn(),
      readFileContent: vi.fn(),
      importFiles: vi.fn(),
      startPreview: vi.fn(),
      previewStatus: vi.fn(),
      stopPreview: vi.fn(),
    },
  }
})

vi.mock("@/lib/agentes-coding/api", () => ({
  AgentesCodingApiError: class extends Error {},
  agentesCodingApi: {
    createSession: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    repoMap: vi.fn(),
    exec: vi.fn(),
    destroy: vi.fn(),
  },
}))

vi.mock("@/components/code/monaco-code-area", () => ({
  default: function MonacoStub({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
    return (
      <textarea
        data-testid="monaco-stub"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
    )
  },
}))

vi.mock("@/components/agentes/coding-monaco-diff", () => ({
  default: () => <div data-testid="diff-stub" />,
}))

vi.mock("@/lib/codex/use-codex-health", async () => {
  const actual = await vi.importActual<typeof import("@/lib/codex/use-codex-health")>(
    "@/lib/codex/use-codex-health",
  )
  return { ...actual, ensureCodexPreviewOrigin: vi.fn() }
})

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    function DynamicStub(props: Record<string, unknown>) {
      const [Comp, setComp] = React.useState<React.ComponentType<Record<string, unknown>> | null>(null)
      React.useEffect(() => {
        let alive = true
        void loader().then((m) => {
          if (!alive) return
          const mod = m as { default?: React.ComponentType<Record<string, unknown>> }
          setComp(() => mod.default ?? (() => null))
        })
        return () => {
          alive = false
        }
      }, [])
      if (!Comp) return <div data-testid="dynamic-loading" />
      return <Comp {...props} />
    }
    return DynamicStub
  },
}))

import { projectsCodexApi } from "@/lib/codex/api/projects"
import { ensureCodexPreviewOrigin } from "@/lib/codex/use-codex-health"

const PROJECT = { id: "p1", name: "App" } as never

async function renderWithProject(files: string[] = ["src/a.ts"]) {
  vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
  vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
  vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(files)
  vi.mocked(projectsCodexApi.readFileContent).mockResolvedValue({ ok: true, path: "src/a.ts", content: "v1" } as never)
  render(<CodingIdeShell />)
  await screen.findByText("a.ts")
}

// Espera a que el efecto del poll programe su intervalo (el montaje del
// proyecto es asíncrono; bajo carga el efecto puede ir detrás del primer
// paint) y ejecuta un tick.
async function nextPollTick(getCbs: () => Array<() => void>) {
  await waitFor(() => expect(getCbs().length).toBeGreaterThan(0))
  await getCbs()[0]()
}

describe("CodingIdeShell auto-refresh", () => {
  let intervalCbs: Array<() => void> = []
  const realSetInterval = window.setInterval.bind(window)

  beforeEach(() => {
    intervalCbs = []
    vi.mocked(projectsCodexApi.getProjectByChat).mockReset()
    vi.mocked(projectsCodexApi.listProjects).mockReset()
    vi.mocked(projectsCodexApi.listFiles).mockReset()
    vi.mocked(projectsCodexApi.readFileContent).mockReset()
    vi.mocked(projectsCodexApi.startPreview).mockReset()
    vi.mocked(projectsCodexApi.previewStatus).mockReset().mockResolvedValue({ running: true } as never)
    vi.mocked(projectsCodexApi.stopPreview).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(ensureCodexPreviewOrigin).mockReset().mockResolvedValue(null)
    // Solo capturamos nuestro poll (15s); el polling interno de
    // testing-library y otros temporizadores siguen con el reloj real.
    vi.spyOn(window, "setInterval").mockImplementation(((cb: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 15_000) {
        intervalCbs.push(cb)
        return 1000 + intervalCbs.length
      }
      return (realSetInterval as (...a: unknown[]) => number)(cb, ms, ...rest)
    }) as unknown as typeof window.setInterval)
    vi.spyOn(window, "clearInterval").mockImplementation((() => undefined) as unknown as typeof window.clearInterval)
  })

  it("programa el poll cada 15s al abrir un proyecto", async () => {
    await renderWithProject()
    // El filtro del mock solo captura el intervalo de 15s, así que basta
    // con esperar a que aparezca (el delay queda garantizado por el filtro).
    await waitFor(() => expect(intervalCbs).toHaveLength(1))
  })

  it("botón Actualizar recarga el árbol y muestra archivos nuevos", async () => {
    await renderWithProject()
    const before = vi.mocked(projectsCodexApi.listFiles).mock.calls.length
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts", "src/b.ts"])
    fireEvent.click(screen.getByTestId("agentes-coding-refresh-files"))
    await screen.findByText("b.ts")
    expect(vi.mocked(projectsCodexApi.listFiles).mock.calls.length).toBeGreaterThan(before)
  })

  it("el poll trae archivos nuevos sin tocar el error", async () => {
    await renderWithProject()
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts", "src/b.ts"])
    await nextPollTick(() => intervalCbs)
    await screen.findByText("b.ts")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("recuperar el foco recarga el árbol", async () => {
    await renderWithProject()
    const before = vi.mocked(projectsCodexApi.listFiles).mock.calls.length
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => {
      expect(vi.mocked(projectsCodexApi.listFiles).mock.calls.length).toBeGreaterThan(before)
    })
  })

  it("sin dirty, el poll recarga el contenido del archivo abierto", async () => {
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    const editor = (await screen.findByTestId("monaco-stub")) as HTMLTextAreaElement
    expect(editor.value).toBe("v1")
    vi.mocked(projectsCodexApi.readFileContent).mockResolvedValue({ ok: true, path: "src/a.ts", content: "v2-del-agente" } as never)
    await nextPollTick(() => intervalCbs)
    await waitFor(() => {
      expect((screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value).toBe("v2-del-agente")
    })
  })

  it("con dirty, el poll NO pisa el borrador del usuario", async () => {
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    const editor = (await screen.findByTestId("monaco-stub")) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "v1+mis-cambios" } })
    expect((screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value).toBe("v1+mis-cambios")
    const readsBefore = vi.mocked(projectsCodexApi.readFileContent).mock.calls.length
    vi.mocked(projectsCodexApi.readFileContent).mockResolvedValue({ ok: true, path: "src/a.ts", content: "v2-del-agente" } as never)
    await nextPollTick(() => intervalCbs)
    // Da un ciclo para que un re-read indebido se hiciera visible.
    await Promise.resolve()
    expect((screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value).toBe("v1+mis-cambios")
    expect(vi.mocked(projectsCodexApi.readFileContent).mock.calls.length).toBe(readsBefore)
  })

  it("el preview hace hot-restart cuando el poll detecta archivos nuevos (sin reiniciar el server)", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/x/",
      previewUrl: "/x/",
      basePath: "/x/",
    } as never)
    await renderWithProject()
    fireEvent.click(screen.getByTestId("agentes-coding-pane-preview"))
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    expect(first).toHaveAttribute("src", "/x/")
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts", "src/b.ts"])
    await nextPollTick(() => intervalCbs)
    await screen.findByText("b.ts")
    await waitFor(() => {
      expect(screen.getByTestId("agentes-preview-iframe")).not.toBe(first)
    })
    expect(screen.getByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/x/")
    expect(vi.mocked(projectsCodexApi.startPreview)).toHaveBeenCalledTimes(1)
  })
})
