import { describe, it, expect } from 'vitest'
import {
  isConversationalMessage,
  isQuickGreeting,
  nextAgentAction,
  type AgentState,
} from '@/lib/code-agent/orchestrator'

// Conversation-first routing: talking to the APPS agent must feel like a chat.
// Help requests and questions NEVER trigger a build; real build orders and
// intake slot answers still flow to the generator.

const state = (phase: AgentState['phase'], intakeStep = 0): AgentState =>
  ({ phase, intakeStep, context: { goal: 'app' } }) as AgentState

const signal = { mode: 'app', hasModel: true } as never

describe('conversational routing (pedir ayuda ≠ construir)', () => {
  it.each([
    'necesito ayuda',
    'ayudame',
    'puedes ayudarme',
    'quiero ayuda con algo',
    '¿qué puedes hacer?',
    'quiero preguntarte algo',
  ])('"%s" es conversación', (text) => {
    expect(isConversationalMessage(text)).toBe(true)
  })

  it.each([
    'crea una tienda online de ropa',
    'hazme un CRM para mi agencia',
    'una cafeteria de especialidad', // respuesta de slot del intake
  ])('"%s" NO es conversación', (text) => {
    expect(isConversationalMessage(text)).toBe(false)
  })

  it('una pregunta a mitad de intake va al chat (passthrough), no al generador', () => {
    const action = nextAgentAction(state('intake', 1), '¿puedes ayudarme?', signal)
    expect(action.type).toBe('passthrough')
  })

  it('una respuesta de slot a mitad de intake sigue generando', () => {
    const action = nextAgentAction(state('intake', 1), 'una cafeteria de especialidad', signal)
    expect(action.type).toBe('generate')
  })

  it('un build real genera', () => {
    const action = nextAgentAction(state('idle'), 'crea una tienda online de ropa', signal)
    expect(action.type).toBe('generate')
  })

  it('saludos puros siguen detectándose (ruta de chat)', () => {
    expect(isQuickGreeting('hola')).toBe(true)
    expect(isQuickGreeting('como estas?')).toBe(true)
    expect(isQuickGreeting('crea una app')).toBe(false)
  })
})
