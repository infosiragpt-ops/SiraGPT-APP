import { describe, it, expect } from 'vitest'
import {
  buildWebGroundingQuery,
  isCodeInformationRequest,
  isConversationalMessage,
  isCodeWriteRequest,
  isQuickGreeting,
  needsWebTools,
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

  it.each([
    'esta es mi web https://www.tesis20.com ¿puedes acceder a ella?',
    'abre tesis20.com y dime qué servicios ofrece',
    'busca en internet información pública sobre Tesis20',
    'abre el sitio web y verifica sus servicios',
    'browse this website and read the pricing page',
    'puedes buscar su repositorio en GitHub?',
    'busca el repositorio de GitHub de Tesis20',
    'busca el proyecto en GitLab',
    'investiga Tesis20',
    'busca precios de competidores',
    '¿cuál es el precio actual del dólar?',
  ])('"%s" exige herramientas web aunque sea conversación', (text) => {
    expect(needsWebTools(text)).toBe(true)
  })

  it.each([
    'hola',
    '¿qué puedes hacer?',
    'explícame qué es React',
    'crea una tienda online',
    'revisa este bug en mi código',
    'revisa el proyecto y luego súbelo a GitHub',
    'abre mi proyecto de GitHub en el workspace',
    'revisa el código local antes de publicarlo en GitHub',
  ])('"%s" no activa herramientas web sin una señal real', (text) => {
    expect(needsWebTools(text)).toBe(false)
  })

  it('resuelve un repositorio remoto deíctico con el último hostname público', () => {
    const query = buildWebGroundingQuery(
      'puedes buscar su repositorio en GitHub?',
      [
        {
          role: 'user',
          content: 'esta es mi web https://www.tesis20.com ¿puedes acceder a ella?',
        },
        {
          role: 'assistant',
          content: 'Sí, pude acceder a tesis20.com.',
        },
      ],
    )

    expect(query).toContain('repositorio en GitHub')
    expect(query).toContain('Objetivo público referido: tesis20.com')
    expect(query).not.toContain('https://')
  })

  it('mantiene "si" en web read-only tras una oferta explícita de búsqueda', () => {
    const query = buildWebGroundingQuery(
      'si',
      [
        {
          role: 'user',
          content: 'esta es mi web https://www.tesis20.com ¿puedes acceder a ella?',
        },
        {
          role: 'assistant',
          content: 'Sí, pude acceder a tesis20.com.',
        },
        {
          role: 'user',
          content: 'puedes buscar su repositorio en GitHub?',
        },
        {
          role: 'assistant',
          content:
            'Puedo intentar buscarlo ahora mismo usando herramientas de búsqueda. No tengo forma de saber de antemano si tesis20.com tiene un repositorio público en GitHub, pero si existe y es público, debería poder encontrarlo. ¿Quieres que lo busque ya?',
        },
      ],
    )

    expect(query).toContain('repositorio en GitHub')
    expect(query).toContain('Objetivo público referido: tesis20.com')
    expect(query).toContain('no pidas otra confirmación')
  })

  it.each([
    'sí, hazlo',
    'hazlo por favor',
    'sí por favor',
    'claro',
    'dale, búscalo',
    'sí, procede',
    'sí, adelante',
    'dale, procede',
    'sí, busca',
  ])('mantiene la confirmación natural "%s" en la búsqueda web previa', (confirmation) => {
    const query = buildWebGroundingQuery(
      confirmation,
      [
        {
          role: 'user',
          content: 'esta es mi web https://www.tesis20.com ¿puedes acceder a ella?',
        },
        {
          role: 'assistant',
          content: 'Sí, pude acceder a tesis20.com.',
        },
        {
          role: 'user',
          content: 'puedes buscar su repositorio en GitHub?',
        },
        {
          role: 'assistant',
          content: 'Puedo buscarlo ahora. ¿Quieres que lo busque ya?',
        },
      ],
    )

    expect(query).toContain('Objetivo público referido: tesis20.com')
    expect(query).toContain('no pidas otra confirmación')
  })

  it.each([
    'cambia el color a rojo',
    'revisa el proyecto y luego súbelo a GitHub',
    '¿puedes publicar mi proyecto en GitHub?',
    '¿puedes cambiar el color a rojo?',
    'quiero que cambies el color a rojo',
    'can you edit the file?',
    'could you fix the bug?',
  ])('clasifica la escritura explícita "%s" como patch aunque el estado sea idle', (text) => {
    expect(nextAgentAction(state('idle'), text, signal)).toEqual({
      type: 'patch',
      instruction: text,
    })
  })

  it.each([
    '¿cómo puedo cambiar el color?',
    'explícame cómo modificar este componente',
    '¿qué incluye React?',
    '¿qué cambia esta función?',
    'quiero saber cómo editar el archivo',
    '¿puedes explicarme cómo hacer un commit?',
    'enséñame a cambiar el color',
    'muéstrame cómo editarlo',
    'no modificar nada, solo explícame',
    "don't push, just explain",
    'no cambies nada',
    'no edites el archivo',
    'no publiques todavía',
    'no hagas commit',
    'por favor no hagas push',
    'no quiero que publiques',
    'quiero que no cambies',
    'sin hacer commit',
    "please don't push",
    'por ahora no cambies nada',
    'de momento no publiques',
    'mejor no hagas commit',
    'el proyecto está bien, no edites nada',
    'todavía no hagas push',
    '¿Incluye autenticación?',
    '¿Actualiza automáticamente?',
    '¿Publica en GitHub?',
    '¿Elimina datos?',
    '¿Cambia el color según el tema?',
  ])('mantiene la mención informativa o negada "%s" fuera de escritura', (text) => {
    expect(isCodeInformationRequest(text)).toBe(true)
    expect(isCodeWriteRequest(text)).toBe(false)
    expect(nextAgentAction(state('idle'), text, signal).type).toBe('passthrough')
    expect(nextAgentAction(state('preview'), text, signal).type).toBe('passthrough')
  })

  it('no hereda "sí" sin una oferta web inmediata', () => {
    expect(
      buildWebGroundingQuery('sí', [
        { role: 'assistant', content: '¿Quieres que cree la aplicación ahora?' },
      ]),
    ).toBeNull()
  })

  it('conserva repositorios locales fuera de la web', () => {
    expect(needsWebTools('revisa este repositorio local del workspace')).toBe(false)
  })

  it('no hereda un hostname anterior después de que el usuario cambia de tema', () => {
    expect(
      buildWebGroundingQuery(
        'puedes buscar su repositorio en GitHub?',
        [
          { role: 'user', content: 'lee https://cliente-antiguo.com' },
          { role: 'assistant', content: 'Leí el sitio público.' },
          { role: 'user', content: 'ahora hablemos de mi calendario' },
          { role: 'assistant', content: 'De acuerdo.' },
        ],
      ),
    ).toBe('puedes buscar su repositorio en GitHub?')
  })
})
