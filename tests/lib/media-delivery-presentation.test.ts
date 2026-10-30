import { describe, expect, it } from 'vitest'
import { summarizeAgentActivity } from '@/lib/agent-task-presentation'
import type { AgentTaskState } from '@/lib/agent-task-service'

describe('persisted media delivery presentation', () => {
  it('renders the compact delivery payload without live repair or validation arrays', () => {
    // This is the shape published by media-delivery.defaultPostMessage.
    const persisted = JSON.parse(JSON.stringify({
      steps: [], artifacts: [{ filename: 'transcripcion.txt' }],
      finalText: 'Transcripción lista.', done: true,
      stoppedReason: 'transcription_finalize', checkpoints: [],
    })) as AgentTaskState
    expect(summarizeAgentActivity(persisted)).toMatchObject({
      status: 'completed', stepCount: 0, validationPassed: 0, validationTotal: 0,
    })
  })

  it('also handles a restored status-only snapshot without a steps array', () => {
    const persisted = JSON.parse('{"queue":{"status":"queued"}}') as AgentTaskState
    expect(summarizeAgentActivity(persisted)).toMatchObject({ status: 'queued', stepCount: 0 })
  })
})
