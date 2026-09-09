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

const PROJECT = { id: "p1", name: "App" } as never

async function renderWithProject(files: string[] = ["src/a.ts"]) {
  vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
  vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
  vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(files)
  vi.mocked(projectsCodexApi.readFileContent).mockResolvedValue({ ok: true, path: "src/a.ts", content: "v1" } as never)
  render(<CodingIdeShell />)
  await screen.findByText("a.ts")
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
    expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 15_000)
    expect(intervalCbs).toHaveLength(1)
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
    await intervalCbs[0]()
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
    await intervalCbs[0]()
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
    await intervalCbs[0]()
    // Da un ciclo para que un re-read indebido se hiciera visible.
    await Promise.resolve()
    expect((screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value).toBe("v1+mis-cambios")
    expect(vi.mocked(projectsCodexApi.readFileContent).mock.calls.length).toBe(readsBefore)
  })
})
