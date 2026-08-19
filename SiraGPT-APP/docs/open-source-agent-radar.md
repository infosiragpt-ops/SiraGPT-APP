# SiraGPT Open Source Agent Radar

Reviewed: 2026-07-06

This radar turns open-source research into SiraGPT-native implementation work. It is not a vendoring plan. External projects are reference material unless a separate license, security, dependency, and architecture review explicitly approves using code or packages.

## Source Policy

- Use external repositories as design references first.
- Do not copy external runtime code into active SiraGPT paths.
- Validate license, advisories, maintenance, and data handling before adding any dependency.
- Keep UI surfaces locked unless the product request explicitly asks for UI changes.
- Do not expose secrets, tokens, `.env` values, private uploads, or customer data in reports.

## Primary References

| Reference | What SiraGPT should learn | SiraGPT-native target |
|---|---|---|
| [OpenHands](https://www.openhands.dev/) / [Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) | Real workspace execution, task tracker, local or ephemeral workspaces, multi-agent refactors | Durable agent task loop, visible plan/apply/verify events, bounded workspaces |
| [Aider](https://github.com/aider-ai/aider) | Repo map, git diff discipline, lint/test repair loop | Codebase map before edits, focused tests, no completion claim without verification |
| [OpenCode](https://opencode.ai/) | Multi-session agents, LSP-style context, provider flexibility, privacy posture | Resumable project agents, provider routing by cost/privacy/task, visible session status |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Stateful long-running agents, durable execution, memory, human gates | Execution graph nodes, retry/resume, approval boundaries for risky tools |
| [Dify](https://github.com/langgenius/dify) | Workflow plus RAG plus agents plus model management and observability | Agentic product OS map across workflow, tools, RAG, model router, cost, deploy |
| [LibreChat](https://github.com/danny-avila/LibreChat) | Provider chat, agents, MCP, artifacts, code interpreter, auth/search | Owner-scoped artifacts, downloads, provider controls, conversation search |
| [Open WebUI](https://docs.openwebui.com/) | Self-hosted provider-agnostic AI interface, tools, knowledge, RAG | Governed tools/knowledge layer shared by local and cloud providers |
| [Docling](https://github.com/docling-project/docling) | Rich document parsing, layout, tables, OCR, gen-AI-ready representation | Source-preserving DOCX/PDF/PPTX/XLSX pipeline with format-fidelity checks |

## P0 Roadmap

- Workspace-backed agent tasks inspired by OpenHands: every software task should show plan, apply, verify, and final evidence while storing durable events.
- Repo map before modifications inspired by Aider: inspect owned files, tests, protected UI, and dependencies before editing.
- Diff plus test repair loop inspired by Aider: no implementation claim without diff, focused tests, and failure handling.
- Stateful agent graph contract inspired by LangGraph: explicit nodes with state, event logs, retry, and resume.
- Artifact ownership and download contract inspired by LibreChat: every generated file must be owner-scoped, previewable when possible, downloadable, and verified.
- Source-preserving document pipeline inspired by Docling: uploaded Office/PDF files must return edited files in the requested format with verification evidence.

## Operational Commands

```bash
npm run agent:opensource:map -- --json
npm run agent:opensource:map -- --recommend "docx pdf editar documentos"
npm run skill:validate:agents
npm run agent:openclaw:map -- --json
npm run agent:hermes:map -- --json
git diff --check
bash scripts/check-secrets.sh
```

## Release Gate

Before promoting a radar-backed improvement to `siragpt.com`, require:

- Focused tests for the exact SiraGPT contract being changed.
- Secret scan and `git diff --check`.
- UI lock verification if any frontend surface changes.
- A live `/chat` or `/code` smoke when user-facing behavior changes.
- A concise final report with source links, exact changed files, and verification output.
