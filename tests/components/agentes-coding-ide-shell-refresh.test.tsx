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
      execInProject: vi.fn(),
      readFileContent: vi.fn(),
      readEditorFile: vi.fn(),
      saveWorkspaceFile: vi.fn(),
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
  default: function MonacoStub({ value, onChange, readOnly, path }: { value: string; onChange?: (v: string) => void; readOnly?: boolean; path: string }) {
    return (
      <textarea
        data-testid="monaco-stub"
        data-model-path={path}
        value={value}
        readOnly={readOnly}
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
const REVISION = "a".repeat(64)
const NEXT_REVISION = "b".repeat(64)
const editorFile = (content: string, revision = REVISION, extra = {}) => ({
  ok: true, path: "src/a.ts", content, revision,
  sizeBytes: new TextEncoder().encode(content).byteLength, truncated: false, readOnly: false, ...extra,
})

async function renderWithProject(files: string[] = ["src/a.ts"]) {
  vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
  vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
  vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(files)
  vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
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
    sessionStorage.clear()
    vi.mocked(projectsCodexApi.getProjectByChat).mockReset()
    vi.mocked(projectsCodexApi.listProjects).mockReset()
    vi.mocked(projectsCodexApi.listFiles).mockReset()
    vi.mocked(projectsCodexApi.readEditorFile).mockReset()
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockReset()
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
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v2-del-agente", NEXT_REVISION))
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
    const readsBefore = vi.mocked(projectsCodexApi.readEditorFile).mock.calls.length
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v2-del-agente", NEXT_REVISION))
    await nextPollTick(() => intervalCbs)
    // Da un ciclo para que un re-read indebido se hiciera visible.
    await Promise.resolve()
    expect((screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value).toBe("v1+mis-cambios")
    expect(vi.mocked(projectsCodexApi.readEditorFile).mock.calls.length).toBe(readsBefore)
  })

  it("el preview hace hot-restart cuando el poll detecta archivos nuevos (sin reiniciar el server)", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/",
      previewUrl: "/api/codex/projects/p1/preview/tok/app/",
      basePath: "/api/codex/projects/p1/preview/tok/app/",
      previewStatus: { project: "p1", ready: true, running: true },
    } as never)
    await renderWithProject()
    fireEvent.click(screen.getByTestId("agentes-coding-pane-preview"))
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    expect(first).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts", "src/b.ts"])
    await nextPollTick(() => intervalCbs)
    await screen.findByText("b.ts")
    await waitFor(() => {
      expect(screen.getByTestId("agentes-preview-iframe")).not.toBe(first)
    })
    expect(screen.getByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    expect(vi.mocked(projectsCodexApi.startPreview)).toHaveBeenCalledTimes(1)
  })
  it("edición iniciada durante una lectura de polling no pierde el borrador", async () => {
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    const editor = await screen.findByTestId("monaco-stub")
    let finish!: (value: any) => void
    vi.mocked(projectsCodexApi.readEditorFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await nextPollTick(() => intervalCbs)
    await waitFor(() => expect(finish).toBeDefined())
    fireEvent.change(editor, { target: { value: "borrador mientras esperaba" } })
    finish(editorFile("cambio remoto", NEXT_REVISION))
    await Promise.resolve()
    expect(editor).toHaveValue("borrador mientras esperaba")
  })

  it("rechaza guardar cuando el agente modificó la versión original", async () => {
    await renderWithProject()
    vi.mocked(projectsCodexApi.importFiles).mockClear()
    fireEvent.click(screen.getByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "mi borrador" } })
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockRejectedValue(Object.assign(new Error("file_conflict"), {
      status: 409, body: { error: "file_conflict" },
    }))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await screen.findByText(/El archivo cambió en el proyecto/)
    expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenCalledWith("p1", {
      path: "src/a.ts", content: "mi borrador", expectedRevision: REVISION,
    })
    expect(projectsCodexApi.importFiles).not.toHaveBeenCalled()
    expect(screen.getByTestId("monaco-stub")).toHaveValue("mi borrador")
  })

  it("no trunca un archivo existente al pulsar Crear", async () => {
    await renderWithProject()
    vi.mocked(projectsCodexApi.importFiles).mockClear()
    fireEvent.change(screen.getByRole("textbox", { name: "Ruta del archivo" }), { target: { value: "src/a.ts" } })
    fireEvent.click(screen.getByRole("button", { name: "Crear", exact: true }))
    await screen.findByText(/Ese archivo ya existe/)
    expect(projectsCodexApi.importFiles).not.toHaveBeenCalled()
  })

  it("modo chat usa conversationId real, solo proyecto y terminal durable", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue({ id: "p1", name: "Mi app" } as never)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.execInProject).mockResolvedValue({ ok: false, exitCode: 7, stderr: "prueba fallida" })
    const ready = vi.fn()
    render(<CodingIdeShell conversationId="query-chat-id" embedded onProjectReady={ready} />)
    await screen.findByText("a.ts")
    expect(projectsCodexApi.getProjectByChat).toHaveBeenCalledWith("query-chat-id")
    expect(screen.queryByTestId("agentes-coding-new-session")).toBeNull()
    expect(screen.queryByTestId("agentes-coding-project-select")).toBeNull()
    fireEvent.click(screen.getByTestId("agentes-coding-pane-terminal"))
    fireEvent.change(screen.getByTestId("agentes-coding-terminal-input"), { target: { value: "npm test" } })
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }))
    await screen.findByText(/Código de salida: 7/)
    expect(projectsCodexApi.execInProject).toHaveBeenCalledWith("p1", "npm test")
    expect(ready).toHaveBeenCalledWith(true)
  })

  it("guarda por revisión, confirma los bytes y permite el siguiente guardado", async () => {
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "mi cambio" } })
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockResolvedValue({
      ok: true, path: "src/a.ts", revision: NEXT_REVISION, sizeBytes: 9,
      written: 1, truncated: false, readOnly: false,
    })
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("mi cambio", NEXT_REVISION))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await waitFor(() => expect(screen.getByTestId("agentes-coding-save")).toBeDisabled())
    expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenLastCalledWith("p1", {
      path: "src/a.ts", content: "mi cambio", expectedRevision: REVISION,
    })
    fireEvent.change(screen.getByTestId("monaco-stub"), { target: { value: "otro cambio" } })
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("otro cambio", "c".repeat(64)))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await waitFor(() => expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenCalledTimes(2))
    expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenLastCalledWith("p1", {
      path: "src/a.ts", content: "otro cambio", expectedRevision: NEXT_REVISION,
    })
  })

  it("no declara guardado si la relectura devuelve otro contenido", async () => {
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "mi cambio" } })
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockResolvedValue({ ok: true } as never)
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("otra escritura", NEXT_REVISION))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await screen.findByText(/No pude confirmar el contenido guardado/)
    expect(screen.getByTestId("monaco-stub")).toHaveValue("mi cambio")
    expect(screen.getByTestId("agentes-coding-save")).toBeEnabled()
  })

  it("un archivo truncado se abre en solo lectura y nunca se guarda", async () => {
    await renderWithProject()
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("", REVISION, {
      revision: null, sizeBytes: 600000, truncated: true, readOnly: true,
    }))
    fireEvent.click(screen.getByText("a.ts"))
    await screen.findByText(/solo lectura/)
    expect(await screen.findByTestId("monaco-stub")).toHaveAttribute("readonly")
    expect(screen.getByTestId("agentes-coding-save")).toBeDisabled()
    expect(projectsCodexApi.saveWorkspaceFile).not.toHaveBeenCalled()
  })

  it("un archivo binario no se convierte en texto editable", async () => {
    await renderWithProject()
    vi.mocked(projectsCodexApi.readEditorFile).mockRejectedValue(Object.assign(new Error("binary_file"), {
      status: 415, body: { error: "binary_file" },
    }))
    fireEvent.click(screen.getByText("a.ts"))
    await screen.findByText(/archivo es binario/)
    expect(screen.queryByTestId("monaco-stub")).toBeNull()
    expect(projectsCodexApi.saveWorkspaceFile).not.toHaveBeenCalled()
  })

  it("crear usa expectedRevision null para no sobrescribir un archivo concurrente", async () => {
    await renderWithProject()
    fireEvent.change(screen.getByRole("textbox", { name: "Ruta del archivo" }), { target: { value: "src/nuevo.ts" } })
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockRejectedValue(Object.assign(new Error("file_conflict"), {
      status: 409, body: { error: "file_conflict" },
    }))
    fireEvent.click(screen.getByRole("button", { name: "Crear", exact: true }))
    await screen.findByText(/El archivo cambió en el proyecto/)
    expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenCalledWith("p1", {
      path: "src/nuevo.ts", content: "", expectedRevision: null,
    })
    expect(projectsCodexApi.importFiles).not.toHaveBeenCalled()
  })

  it("guardar refresca el preview aunque el árbol no cambie", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({ previewUrl: "/api/codex/projects/p1/preview/tok/app/", devUrl: "/api/codex/projects/p1/preview/tok/app/", basePath: "/api/codex/projects/p1/preview/tok/app/", previewStatus: { project: "p1", ready: true, running: true } })
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "mi cambio" } })
    fireEvent.click(screen.getByTestId("agentes-coding-pane-preview"))
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockResolvedValue({ ok: true } as never)
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("mi cambio", NEXT_REVISION))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await waitFor(() => expect(screen.getByTestId("agentes-preview-iframe")).not.toBe(first))
    expect(projectsCodexApi.startPreview).toHaveBeenCalledTimes(1)
  })

  it("el guardado real refresca el preview aunque falle la relectura", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({ previewUrl: "/api/codex/projects/p1/preview/tok/app/", devUrl: "/api/codex/projects/p1/preview/tok/app/", basePath: "/api/codex/projects/p1/preview/tok/app/", previewStatus: { project: "p1", ready: true, running: true } })
    await renderWithProject()
    fireEvent.click(screen.getByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "mi cambio" } })
    fireEvent.click(screen.getByTestId("agentes-coding-pane-preview"))
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockResolvedValue({ ok: true } as never)
    vi.mocked(projectsCodexApi.readEditorFile).mockRejectedValue(new Error("No pude releer el archivo"))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await screen.findByText("No pude releer el archivo")
    await waitFor(() => expect(screen.getByTestId("agentes-preview-iframe")).not.toBe(first))
    fireEvent.click(screen.getByTestId("agentes-coding-pane-editor"))
    expect(await screen.findByTestId("monaco-stub")).toHaveValue("mi cambio")
    expect(screen.getByTestId("agentes-coding-save")).toBeEnabled()
    expect(projectsCodexApi.startPreview).toHaveBeenCalledTimes(1)
  })

  it("un poll sin cambios no recarga el preview", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({ previewUrl: "/api/codex/projects/p1/preview/tok/app/", devUrl: "/api/codex/projects/p1/preview/tok/app/", basePath: "/api/codex/projects/p1/preview/tok/app/", previewStatus: { project: "p1", ready: true, running: true } })
    await renderWithProject()
    fireEvent.click(screen.getByTestId("agentes-coding-pane-preview"))
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    await nextPollTick(() => intervalCbs)
    await Promise.resolve()
    expect(screen.getByTestId("agentes-preview-iframe")).toBe(first)
  })

  it("recupera un borrador de la misma cuenta con su revisión original", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    const first = render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "borrador pendiente" } })
    first.unmount()
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("nuevo remoto", NEXT_REVISION))
    render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    await screen.findByText(/Recuperé tu borrador. El archivo cambió/)
    expect(screen.getByTestId("monaco-stub")).toHaveValue("borrador pendiente")
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockRejectedValue(new Error("conflicto"))
    fireEvent.click(screen.getByTestId("agentes-coding-save"))
    await waitFor(() => expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenCalledWith("p1", {
      path: "src/a.ts", content: "borrador pendiente", expectedRevision: REVISION,
    }))
  })

  it("no muestra el borrador de otra cuenta", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    const first = render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "borrador privado" } })
    first.unmount()
    render(<CodingIdeShell userId="usuario-b" />)
    fireEvent.click(await screen.findByText("a.ts"))
    expect(await screen.findByTestId("monaco-stub")).toHaveValue("v1")
  })

  it("elimina el borrador al descartarlo explícitamente", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    const first = render(<CodingIdeShell userId="usuario-a" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "borrador pendiente" } })
    expect(sessionStorage.length).toBe(1)
    fireEvent.click(screen.getByTestId("agentes-coding-ide-collapse"))
    expect(sessionStorage.length).toBe(0)
    first.unmount()
  })

  it("avisa al recargar con cambios y no persiste contenido sensible", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "Authorization: Bearer example_test_only" } })
    expect(sessionStorage.length).toBe(0)
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it("deshacer hasta el original elimina el borrador anterior", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    const editor = await screen.findByTestId("monaco-stub")
    fireEvent.change(editor, { target: { value: "cambio deshecho" } })
    expect(sessionStorage.length).toBe(1)
    fireEvent.change(editor, { target: { value: "v1" } })
    expect(sessionStorage.length).toBe(0)
  })

  it("cambiar de cuenta en el mismo montaje no copia el borrador anterior", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(PROJECT)
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
    vi.mocked(projectsCodexApi.listFiles).mockResolvedValue(["src/a.ts"])
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("v1"))
    const view = render(<CodingIdeShell userId="usuario-a" />)
    fireEvent.click(await screen.findByText("a.ts"))
    fireEvent.change(await screen.findByTestId("monaco-stub"), { target: { value: "borrador de A" } })
    const previousModel = screen.getByTestId("monaco-stub").getAttribute("data-model-path")
    expect(previousModel).toBeTruthy()
    view.rerender(<CodingIdeShell userId="usuario-b" />)
    fireEvent.click(await screen.findByText("a.ts"))
    const nextEditor = await screen.findByTestId("monaco-stub")
    expect(nextEditor).toHaveValue("v1")
    expect(nextEditor).not.toHaveAttribute("data-model-path", previousModel)
    expect(sessionStorage.length).toBe(1)
  })

  it("crear un archivo confirma su nueva versión y actualiza el árbol", async () => {
    await renderWithProject()
    const paths = ["src/a.ts"]
    vi.mocked(projectsCodexApi.listFiles).mockImplementation(async () => [...paths])
    vi.mocked(projectsCodexApi.saveWorkspaceFile).mockImplementation(async () => {
      paths.push("src/nuevo.ts")
      return { ok: true, path: "src/nuevo.ts", revision: NEXT_REVISION, sizeBytes: 0, written: 1, truncated: false, readOnly: false }
    })
    vi.mocked(projectsCodexApi.readEditorFile).mockResolvedValue(editorFile("", NEXT_REVISION, { path: "src/nuevo.ts" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Ruta del archivo" }), { target: { value: "src/nuevo.ts" } })
    fireEvent.click(screen.getByRole("button", { name: "Crear", exact: true }))
    await screen.findByRole("button", { name: "nuevo.ts", exact: true })
    expect(await screen.findByTestId("monaco-stub")).toHaveValue("")
    expect(screen.getByTestId("monaco-stub")).not.toHaveAttribute("readonly")
    expect(projectsCodexApi.saveWorkspaceFile).toHaveBeenCalledWith("p1", {
      path: "src/nuevo.ts", content: "", expectedRevision: null,
    })
  })

})
