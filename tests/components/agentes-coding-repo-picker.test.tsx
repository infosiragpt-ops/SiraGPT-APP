import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  CodingRepoPicker,
  filterRepos,
  parseGithubRepoInput,
} from "@/components/agentes/coding-repo-picker"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { githubService } from "@/lib/github-service"

vi.mock("@/lib/github-service", () => ({
  githubService: {
    status: vi.fn(),
    connectUrl: vi.fn(),
    listRepos: vi.fn(),
    searchRepos: vi.fn(),
    listBranches: vi.fn(),
  },
}))

vi.mock("@/lib/codex/api/projects", () => ({
  projectsCodexApi: {
    cloneRepository: vi.fn(),
  },
}))

const repos = [
  {
    repoId: "1",
    fullName: "acme/app",
    owner: "acme",
    name: "app",
    private: true,
    defaultBranch: "production-main",
    cloneUrl: "https://github.com/acme/app.git",
    htmlUrl: "https://github.com/acme/app",
  },
  {
    repoId: "2",
    fullName: "acme/docs",
    owner: "acme",
    name: "docs",
    private: false,
    defaultBranch: "main",
    cloneUrl: "https://github.com/acme/docs.git",
    htmlUrl: "https://github.com/acme/docs",
  },
]

const cloneResult = {
  project: {
    id: "p1",
    name: "app",
    status: "ready",
    workspacePath: "projects/p1",
    previewUrl: null,
    error: null,
    kind: "repo" as const,
    chatId: "chat1",
    sourceControl: {
      repository: "https://github.com/acme/app.git",
      webUrl: "https://github.com/acme/app",
      fullName: "acme/app",
      private: true,
      defaultBranch: "production-main",
      sourceBranch: "feat/x",
    },
  },
  chatId: "chat1",
  sourceControl: {
    repository: "https://github.com/acme/app",
    fullName: "acme/app",
    private: true,
    defaultBranch: "production-main",
    authenticated: true,
    sourceBranch: "feat/x",
    workBranch: null,
    commitSha: "abc123",
  },
}

describe("parseGithubRepoInput / filterRepos", () => {
  it("acepta URL completa, host sin esquema, .git, subrutas y owner/repo corto", () => {
    for (const input of [
      "https://github.com/sst/opencode",
      "https://www.github.com/sst/opencode.git",
      "github.com/sst/opencode/tree/main/src",
      "sst/opencode",
      "  https://github.com/sst/opencode?tab=readme  ",
    ]) {
      expect(parseGithubRepoInput(input)).toEqual({
        owner: "sst",
        name: "opencode",
        fullName: "sst/opencode",
        htmlUrl: "https://github.com/sst/opencode",
      })
    }
  })

  it("rechaza texto de búsqueda, otros hosts y traversal", () => {
    for (const input of ["app", "", "https://gitlab.com/a/b", "https://github.com/onlyowner", "a/..", "../x", "evil.com/a/b"]) {
      expect(parseGithubRepoInput(input)).toBeNull()
    }
  })

  it("filterRepos filtra por fullName o name sin distinguir mayúsculas", () => {
    expect(filterRepos(repos as never, "DOCS").map((r) => r.fullName)).toEqual(["acme/docs"])
    expect(filterRepos(repos as never, "").length).toBe(2)
  })
})

describe("CodingRepoPicker", () => {
  beforeEach(() => {
    vi.mocked(githubService.status).mockReset()
    vi.mocked(githubService.connectUrl).mockReset()
    vi.mocked(githubService.listRepos).mockReset()
    vi.mocked(githubService.searchRepos).mockReset()
    vi.mocked(githubService.listBranches).mockReset()
    vi.mocked(projectsCodexApi.cloneRepository).mockReset()
  })

  it("muestra el chip del repo vinculado (nombre, rama, privado) y ningún selector", () => {
    render(
      <CodingRepoPicker
        chatId="chat1"
        sourceControl={cloneResult.project.sourceControl}
        onBound={vi.fn()}
      />,
    )
    const chip = screen.getByTestId("agentes-coding-repo-chip")
    expect(chip).toHaveAttribute("href", "https://github.com/acme/app")
    expect(screen.getByTestId("agentes-coding-repo-chip-name")).toHaveTextContent("acme/app")
    expect(screen.getByTestId("agentes-coding-repo-chip-branch")).toHaveTextContent("feat/x")
    expect(screen.getByLabelText("Privado")).toBeInTheDocument()
    expect(screen.queryByTestId("agentes-coding-repo-trigger")).toBeNull()
  })

  it("sin GitHub conectado ofrece Conectar y vincula un repo público por URL con rama manual", async () => {
    vi.mocked(githubService.status).mockResolvedValue({ connected: false, configured: true } as never)
    vi.mocked(githubService.connectUrl).mockResolvedValue({ url: "https://github.com/login/oauth/authorize?x=1" })
    vi.mocked(projectsCodexApi.cloneRepository).mockResolvedValue(cloneResult as never)
    const navigate = vi.fn()
    const onBound = vi.fn()
    render(<CodingRepoPicker chatId="chat1" onBound={onBound} navigate={navigate} />)

    fireEvent.click(screen.getByTestId("agentes-coding-repo-trigger"))
    expect(await screen.findByTestId("agentes-coding-repo-disconnected")).toBeInTheDocument()
    expect(githubService.listRepos).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("agentes-coding-repo-connect"))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?x=1"))

    fireEvent.change(screen.getByTestId("agentes-coding-repo-search"), {
      target: { value: "https://github.com/sst/opencode" },
    })
    fireEvent.click(screen.getByTestId("agentes-coding-repo-manual"))
    // Sin cuenta no se consultan ramas: la rama se escribe a mano (main por defecto).
    const branchInput = await screen.findByTestId("agentes-coding-repo-branch-input")
    expect(branchInput).toHaveValue("main")
    expect(githubService.listBranches).not.toHaveBeenCalled()
    fireEvent.change(branchInput, { target: { value: "dev" } })

    fireEvent.click(screen.getByTestId("agentes-coding-repo-bind"))
    await waitFor(() => expect(onBound).toHaveBeenCalledWith(cloneResult))
    expect(projectsCodexApi.cloneRepository).toHaveBeenCalledWith({
      name: "opencode",
      repoUrl: "https://github.com/sst/opencode",
      branch: "dev",
      chatId: "chat1",
    })
    await waitFor(() => expect(screen.queryByTestId("agentes-coding-repo-panel")).toBeNull())
  })

  it("con GitHub conectado lista repos, filtra, preselecciona la rama por defecto y vincula al chat", async () => {
    vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, login: "luis" } as never)
    vi.mocked(githubService.listRepos).mockResolvedValue({ repos, page: 1, count: 2 } as never)
    vi.mocked(githubService.listBranches).mockResolvedValue({
      owner: "acme",
      repo: "app",
      defaultBranch: "production-main",
      branches: [
        { name: "production-main", protected: true, commitSha: "a" },
        { name: "feat/x", protected: false, commitSha: "b" },
      ],
      count: 2,
    })
    vi.mocked(projectsCodexApi.cloneRepository).mockResolvedValue(cloneResult as never)
    const onBound = vi.fn()
    render(<CodingRepoPicker chatId="chat1" onBound={onBound} />)

    fireEvent.click(screen.getByTestId("agentes-coding-repo-trigger"))
    expect(await screen.findAllByTestId("agentes-coding-repo-option")).toHaveLength(2)
    expect(screen.getByText("luis")).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("agentes-coding-repo-search"), { target: { value: "app" } })
    const options = screen.getAllByTestId("agentes-coding-repo-option")
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent("acme/app")
    expect(githubService.searchRepos).not.toHaveBeenCalled()

    fireEvent.click(options[0])
    await waitFor(() => expect(githubService.listBranches).toHaveBeenCalledWith("acme", "app"))
    const select = (await screen.findByTestId("agentes-coding-repo-branch")) as HTMLSelectElement
    expect(select.value).toBe("production-main")
    fireEvent.change(select, { target: { value: "feat/x" } })

    fireEvent.click(screen.getByTestId("agentes-coding-repo-bind"))
    await waitFor(() => expect(onBound).toHaveBeenCalledWith(cloneResult))
    expect(projectsCodexApi.cloneRepository).toHaveBeenCalledWith({
      name: "app",
      repoUrl: "https://github.com/acme/app",
      branch: "feat/x",
      chatId: "chat1",
    })
  })

  it("409 chat_already_bound muestra el mensaje, no cierra y no llama a onBound", async () => {
    vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, login: "luis" } as never)
    vi.mocked(githubService.listRepos).mockResolvedValue({ repos, page: 1, count: 2 } as never)
    vi.mocked(githubService.listBranches).mockResolvedValue({
      owner: "acme",
      repo: "docs",
      defaultBranch: "main",
      branches: [{ name: "main", protected: false, commitSha: "a" }],
      count: 1,
    })
    vi.mocked(projectsCodexApi.cloneRepository).mockRejectedValue(
      Object.assign(new Error("codex http 409"), { status: 409, body: { error: "chat_already_bound" } }),
    )
    const onBound = vi.fn()
    render(<CodingRepoPicker chatId="chat1" onBound={onBound} />)

    fireEvent.click(screen.getByTestId("agentes-coding-repo-trigger"))
    const options = await screen.findAllByTestId("agentes-coding-repo-option")
    fireEvent.click(options[1])
    await screen.findByTestId("agentes-coding-repo-branch")
    fireEvent.click(screen.getByTestId("agentes-coding-repo-bind"))

    expect(await screen.findByTestId("agentes-coding-repo-error")).toHaveTextContent("ya tiene un proyecto vinculado")
    expect(onBound).not.toHaveBeenCalled()
    expect(screen.getByTestId("agentes-coding-repo-panel")).toBeInTheDocument()
  })

  it("el disparador queda deshabilitado sin chat", () => {
    render(<CodingRepoPicker chatId="" onBound={vi.fn()} disabled />)
    expect(screen.getByTestId("agentes-coding-repo-trigger")).toBeDisabled()
  })
})
