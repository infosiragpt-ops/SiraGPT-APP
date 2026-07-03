import { describe, it, expect, vi } from 'vitest'
import { renderWithIntl as render, screen, fireEvent } from '../lib/codex/intl-test-utils'
import { PlanCard } from '@/components/codex/plan-card'
import { RunSummaryCard } from '@/components/codex/run-summary-card'
import { ActionRequiredCard } from '@/components/codex/action-required-card'
import { CheckpointCard } from '@/components/codex/checkpoint-card'

describe('PlanCard', () => {
  it('renders the plan and approves', async () => {
    const onApprove = vi.fn()
    render(<PlanCard architecture="Vite SPA" pages={['/']} components={['Nav']} tasks={[{ title: 'init' }]} approved={false} waiting onApprove={onApprove} />)
    expect(screen.getByText('Vite SPA')).toBeTruthy()
    expect(screen.getByText(/esperando aprobación/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Aprobar y construir/))
    expect(onApprove).toHaveBeenCalled()
  })

  it('collapses to an approved state without action buttons', () => {
    render(<PlanCard architecture="X" pages={[]} components={[]} tasks={[]} approved onApprove={vi.fn()} />)
    expect(screen.getByText(/aprobado/)).toBeTruthy()
    expect(screen.queryByText(/Aprobar y construir/)).toBeNull()
  })

  it('re-plans from feedback: "Ajustar" reveals the field, "Re-planificar" fires onReplan (G4)', async () => {
    const onReplan = vi.fn().mockResolvedValue(undefined)
    render(<PlanCard architecture="Vite SPA" pages={['/']} components={['Nav']} tasks={[{ title: 'init' }]} approved={false} waiting onReplan={onReplan} />)
    // The feedback field is hidden until "Ajustar" is clicked.
    expect(screen.queryByPlaceholderText(/Qué debería cambiar/)).toBeNull()
    fireEvent.click(screen.getByText(/Ajustar/))
    const field = screen.getByPlaceholderText(/Qué debería cambiar/) as HTMLTextAreaElement
    expect(field).toBeTruthy()
    // Re-plan is disabled while the feedback is empty.
    const replanBtn = screen.getByText(/Re-planificar/).closest('button') as HTMLButtonElement
    expect(replanBtn.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'agrega un carrito' } })
    expect(replanBtn.disabled).toBe(false)
    fireEvent.click(replanBtn)
    expect(onReplan).toHaveBeenCalledWith('agrega un carrito')
  })

  it('falls back to onAdjust (focus composer) when no onReplan handler is given', () => {
    const onAdjust = vi.fn()
    render(<PlanCard architecture="X" pages={[]} components={[]} tasks={[]} approved={false} waiting onApprove={vi.fn()} onAdjust={onAdjust} />)
    fireEvent.click(screen.getByText(/Ajustar/))
    expect(onAdjust).toHaveBeenCalled()
    // No inline feedback field without a re-plan handler.
    expect(screen.queryByPlaceholderText(/Qué debería cambiar/)).toBeNull()
  })
})

describe('RunSummaryCard', () => {
  it('shows metrics and the struck-through price only when original > applied', () => {
    render(<RunSummaryCard metrics={{ timeWorkedMs: 120_000, actionsCount: 5, itemsReadLines: 30, additions: 12, deletions: 3, costOriginalUsd: 1, costAppliedUsd: 0.9, costSource: 'openrouter_generation' }} />)
    expect(screen.getByText(/Trabajó 2 min/)).toBeTruthy()
    expect(screen.getByText('5 acciones')).toBeTruthy()
    expect(screen.getByText('+12 −3')).toBeTruthy()
    expect(screen.getByText('$1.00')).toBeTruthy() // struck-through original (≥1 → 2 decimals)
    expect(screen.getByText('$0.900')).toBeTruthy() // applied (<1 → 3 decimals)
    expect(screen.queryByText(/estimado/)).toBeNull()
  })

  it('shows the estimado badge and no strikethrough when equal', () => {
    render(<RunSummaryCard metrics={{ timeWorkedMs: 1000, costOriginalUsd: 0, costAppliedUsd: 0, costSource: 'estimated' }} />)
    expect(screen.getByText(/estimado/)).toBeTruthy()
  })

  it('expands the usage detail with model, tokens and per-direction cost', () => {
    render(<RunSummaryCard metrics={{ timeWorkedMs: 1000, tokensIn: 12480, tokensOut: 3120, model: 'anthropic/claude-opus', costOriginalUsd: 0.12, costAppliedUsd: 0.12, costInputUsd: 0.09, costOutputUsd: 0.03, costSource: 'provider_exact' }} />)
    // Detail is collapsed by default.
    expect(screen.queryByText('Modelo')).toBeNull()
    fireEvent.click(screen.getByTitle('Detalle de uso'))
    expect(screen.getByText('Modelo')).toBeTruthy()
    expect(screen.getByText('anthropic/claude-opus')).toBeTruthy()
    expect(screen.getByText('12,480')).toBeTruthy() // input tokens, grouped
    expect(screen.getByText('3,120')).toBeTruthy() // output tokens
    expect(screen.getByText('$0.090')).toBeTruthy() // input cost
    expect(screen.getByText('$0.030')).toBeTruthy() // output cost
    expect(screen.getByText('Costo total')).toBeTruthy()
  })

  it('shows a session total when a session accumulator is provided', () => {
    render(
      <RunSummaryCard
        metrics={{ timeWorkedMs: 1000, costAppliedUsd: 0.5, costSource: 'openrouter_generation' }}
        session={{ costAppliedUsd: 1.25, costOriginalUsd: 1.4, tokensIn: 100, tokensOut: 50, runs: 3 }}
      />,
    )
    expect(screen.getByText(/Esta ejecución/)).toBeTruthy()
    expect(screen.getByText(/Sesión/)).toBeTruthy()
    expect(screen.getByText('$1.25')).toBeTruthy() // session applied total
    expect(screen.getByText(/3 ejecuciones/)).toBeTruthy()
  })
})

describe('ActionRequiredCard', () => {
  it('renders the raw error, blocked capabilities and a remediation link', () => {
    render(<ActionRequiredCard title="Sin créditos" rawError="402 Insufficient credits" blockedCapabilities={['Generación']} remediationUrl="https://openrouter.ai/credits" />)
    expect(screen.getByText(/Acción requerida de su parte/)).toBeTruthy()
    expect(screen.getByText('402 Insufficient credits')).toBeTruthy()
    expect(screen.getByText('Generación')).toBeTruthy()
    const link = screen.getByText(/Remediar/).closest('a')
    expect(link?.getAttribute('href')).toBe('https://openrouter.ai/credits')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('copies the raw error', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ActionRequiredCard title="x" rawError="boom" blockedCapabilities={[]} />)
    fireEvent.click(screen.getByText(/Copiar/))
    expect(writeText).toHaveBeenCalledWith('boom')
  })
})

describe('CheckpointCard', () => {
  it('renders title + short sha and opens the rollback confirm dialog', () => {
    render(<CheckpointCard checkpointId="cp1" commitSha="abc1234def" title="feat: hero" createdAt={new Date().toISOString()} />)
    expect(screen.getByText('feat: hero')).toBeTruthy()
    expect(screen.getByText('abc1234')).toBeTruthy()
    fireEvent.click(screen.getByText('Rollback here'))
    expect(screen.getByText(/se descartarán/i)).toBeTruthy()
    // Cancelling closes the dialog without calling anything.
    fireEvent.click(screen.getByText('Cancelar'))
    expect(screen.queryByText(/se descartarán/i)).toBeNull()
  })
})
