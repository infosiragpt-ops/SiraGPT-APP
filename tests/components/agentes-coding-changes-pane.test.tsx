import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CodingChangesPane, splitUnifiedDiff } from "@/components/agentes/coding-changes-pane"
import { projectsCodexApi } from "@/lib/codex/api/projects"

vi.mock("@/lib/codex/api/projects", () => ({
  projectsCodexApi: {
    getWorkspaceChanges: vi.fn(),
    publishWorkspace: vi.fn(),
  },
}))

const sourceControl = {
  repository: "https://github.com/acme/app.git",
  webUrl: "https://github.com/acme/app",
  fullName: "acme/app",
  private: true,
  defaultBranch: "production-main",
  sourceBranch: "production-main",
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/notes.md b/notes.md",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1 @@",
  "+hola",
  "Binary files /dev/null and b/bin/blob.dat differ",
].join("\n")

const changes = {
  ok: true,
  base: { branch: "production-main", sha: "basesha1" },
  head: { branch: "production-main", sha: "headsha2", ahead: 0 },
  files: [
    { path: "src/a.ts", status: "modified" as const, additions: 2, deletions: 1, binary: false, uncommitted: true },
    { path: "notes.md", status: "untracked" as const, additions: 1, deletions: 0, binary: false, uncommitted: true },
    { path: "bin/blob.dat", status: "untracked" as const, additions: 0, deletions: 0, binary: true, uncommitted: true },
  ],
  filesChanged: 3,
  additions: 3,
  deletions: 1,
  diff: DIFF,
  truncated: false,
  dirty: true,
  repository: { url: "https://github.com/acme/app", fullName: "acme/app" },
}

function http428(plan: Record<string, unknown>) {
  return Object.assign(new Error("codex http 428"), { status: 428, body: { error: "confirmation_required", plan } })
}

describe("splitUnifiedDiff", () => {
  it("separa por archivo usando la ruta destino y agrupa binarios sueltos", () => {
    const sections = splitUnifiedDiff(DIFF)
    expect(sections.map((s) => s.path)).toEqual(["src/a.ts", "notes.md", "bin/blob.dat"])
    expect(sections[0].text).toContain("+more")
    expect(sections[0].text).not.toContain("+hola")
    expect(splitUnifiedDiff("")).toEqual([])
  })
})

describe("CodingChangesPane", () => {
  beforeEach(() => {
    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockReset()
    vi.mocked(projectsCodexApi.publishWorkspace).mockReset()
  })

  it("sin repo vinculado muestra la pista y no consulta el backend", () => {
    render(<CodingChangesPane projectId="p1" sourceControl={null} fileVersion={0} />)
    expect(screen.getByTestId("agentes-coding-changes-unlinked")).toBeInTheDocument()
    expect(projectsCodexApi.getWorkspaceChanges).not.toHaveBeenCalled()
  })

  it("lista archivos con estado, resumen y diff; seleccionar un archivo filtra su sección", async () => {
    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockResolvedValue(changes as never)
    const onOpenFile = vi.fn()
    render(<CodingChangesPane projectId="p1" sourceControl={sourceControl} fileVersion={0} onOpenFile={onOpenFile} />)

    await waitFor(() => expect(projectsCodexApi.getWorkspaceChanges).toHaveBeenCalledWith("p1"))
    expect(await screen.findByTestId("agentes-coding-changes-summary")).toHaveTextContent("3 archivos")
    const files = screen.getAllByTestId("agentes-coding-changes-file")
    expect(files).toHaveLength(3)
    expect(files[0]).toHaveTextContent("src/a.ts")
    expect(files[0]).toHaveTextContent("+2 −1")
    expect(files[2]).toHaveTextContent("bin")
    expect(screen.getAllByTestId("agentes-coding-changes-section")).toHaveLength(3)

    fireEvent.click(files[1])
    const only = screen.getAllByTestId("agentes-coding-changes-section")
    expect(only).toHaveLength(1)
    expect(only[0]).toHaveAttribute("data-path", "notes.md")
    expect(only[0]).toHaveTextContent("+hola")

    fireEvent.doubleClick(files[0])
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts")

    fireEvent.click(files[1])
    expect(screen.getAllByTestId("agentes-coding-changes-section")).toHaveLength(3)
  })

  it("Crear PR: primero el plan (428, sin confirmar), luego Confirmar abre el PR y recarga", async () => {
    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockResolvedValue(changes as never)
    vi.mocked(projectsCodexApi.publishWorkspace)
      .mockRejectedValueOnce(http428({ status: "ready_to_publish", base: "production-main", branch: "run/agentes-p1-202609120607", files: 3, hasGithubToken: true }))
      .mockResolvedValueOnce({
        plan: { status: "ready_to_publish", base: "production-main", branch: "run/agentes-p1-202609120607", title: "feat: x" },
        pullRequest: { number: 12, url: "https://github.com/acme/app/pull/12", state: "open" },
        branch: "run/agentes-p1-202609120607",
        commitSha: "def5678",
      })
    render(<CodingChangesPane projectId="p1" sourceControl={sourceControl} fileVersion={0} />)
    await screen.findByTestId("agentes-coding-changes-summary")

    fireEvent.change(screen.getByTestId("agentes-coding-changes-pr-title"), { target: { value: "feat: x" } })
    fireEvent.click(screen.getByTestId("agentes-coding-changes-pr-create"))
    expect(await screen.findByTestId("agentes-coding-changes-plan")).toHaveTextContent("3 archivos → run/agentes-p1-202609120607 contra production-main")
    expect(projectsCodexApi.publishWorkspace).toHaveBeenNthCalledWith(1, "p1", { title: "feat: x", confirm: false })

    fireEvent.click(screen.getByTestId("agentes-coding-changes-pr-confirm"))
    const link = await screen.findByTestId("agentes-coding-changes-pr-link")
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/pull/12")
    expect(link).toHaveTextContent("PR #12")
    expect(projectsCodexApi.publishWorkspace).toHaveBeenNthCalledWith(2, "p1", { title: "feat: x", confirm: true })
    await waitFor(() => expect(projectsCodexApi.getWorkspaceChanges).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("agentes-coding-changes-pr-confirm")).toBeNull()
  })

  it("plan github_auth_required: pide conectar GitHub y no ofrece confirmar", async () => {
    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockResolvedValue(changes as never)
    vi.mocked(projectsCodexApi.publishWorkspace).mockRejectedValueOnce(
      http428({ status: "github_auth_required", base: "production-main", files: 3, hasGithubToken: false }),
    )
    render(<CodingChangesPane projectId="p1" sourceControl={sourceControl} fileVersion={0} />)
    await screen.findByTestId("agentes-coding-changes-summary")
    fireEvent.click(screen.getByTestId("agentes-coding-changes-pr-create"))
    expect(await screen.findByTestId("agentes-coding-changes-plan")).toHaveTextContent("Conecta GitHub")
    expect(screen.queryByTestId("agentes-coding-changes-pr-confirm")).toBeNull()
  })

  it("errores del backend se traducen (base divergente) y el botón queda deshabilitado sin cambios", async () => {
    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockResolvedValue(changes as never)
    vi.mocked(projectsCodexApi.publishWorkspace).mockRejectedValueOnce(
      Object.assign(new Error("codex http 409"), { status: 409, body: { error: "base_branch_diverged" } }),
    )
    render(<CodingChangesPane projectId="p1" sourceControl={sourceControl} fileVersion={0} />)
    await screen.findByTestId("agentes-coding-changes-summary")
    fireEvent.click(screen.getByTestId("agentes-coding-changes-pr-create"))
    expect(await screen.findByTestId("agentes-coding-changes-pr-error")).toHaveTextContent("La rama base avanzó")

    vi.mocked(projectsCodexApi.getWorkspaceChanges).mockResolvedValue({ ...changes, files: [], filesChanged: 0, additions: 0, deletions: 0, diff: "", dirty: false } as never)
    fireEvent.click(screen.getByTestId("agentes-coding-changes-refresh"))
    expect(await screen.findByTestId("agentes-coding-changes-empty")).toHaveTextContent("Sin cambios")
    expect(screen.getByTestId("agentes-coding-changes-pr-create")).toBeDisabled()
  })
})
