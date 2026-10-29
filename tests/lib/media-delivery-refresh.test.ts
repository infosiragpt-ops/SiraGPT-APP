import { describe, expect, it } from 'vitest'
import { pendingMediaDeliveryRefreshKey } from '@/lib/media-delivery-refresh'
import { mergeChatPreservingUserMessages } from '@/lib/message-preservation'

const handoff = (deliveryId = 'md_current', fileIds = ['audio-1']) => ({
  id: `handoff-${deliveryId}`, role: 'ASSISTANT', content: 'Te aviso aquí.',
  metadata: { mediaDeliveryHandoff: deliveryId, transcriptionFileIds: fileIds, stoppedReason: 'media_delivery_handoff' },
})
const delivery = (deliveryId = 'md_current', fileIds = ['audio-1']) => ({
  id: `delivered-${deliveryId}`, role: 'ASSISTANT', content: 'Transcripción terminada.',
  metadata: { source: 'media-delivery', mediaDelivery: deliveryId, transcriptionFileIds: fileIds, artifacts: [{ filename: 'transcripcion.txt' }] },
})

describe('durable transcription refresh identity', () => {
  it('does not settle a new request from an older delivery of the same source file', () => {
    const messages = [delivery('md_old'), handoff()]
    expect(pendingMediaDeliveryRefreshKey(messages)).not.toBe('')
    expect(pendingMediaDeliveryRefreshKey([...messages, delivery()])).toBe('')
  })

  it('keeps concurrent requests for the same file separate by their delivery identity', () => {
    const messages = [handoff('md_first'), handoff('md_second'), delivery('md_first')]
    const pending = pendingMediaDeliveryRefreshKey(messages)
    expect(pending).toContain('md_second')
    expect(pending).not.toContain('md_first')
    expect(pendingMediaDeliveryRefreshKey([...messages, delivery('md_second')])).toBe('')
  })

  it('settles an exact delivery committed before the handoff acknowledgement', () => {
    expect(pendingMediaDeliveryRefreshKey([delivery(), handoff()])).toBe('')
  })

  it('waits for every file when a batch only names its first delivery', () => {
    const messages = [handoff('md_current', ['audio-1', 'audio-2']), delivery()]
    expect(pendingMediaDeliveryRefreshKey(messages)).toContain('audio-2')
    expect(pendingMediaDeliveryRefreshKey([...messages, delivery('md_second', ['audio-2'])])).toBe('')
  })

  it('reads pending references from a live reducer meta envelope without requiring a handoff stop reason', () => {
    const content = '```agent-task-state\n' + JSON.stringify({ done: true, stoppedReason: 'finalized',
      meta: { mediaDeliveryHandoff: 'md_current', transcriptionFileIds: ['audio-1'] } }) + '\n```'
    const messages = [{ id: 'live', role: 'ASSISTANT', content }]
    expect(pendingMediaDeliveryRefreshKey(messages)).not.toBe('')
    expect(pendingMediaDeliveryRefreshKey([...messages, delivery()])).toBe('')
  })

  it('does not treat user text, ordinary replies or attachments as a terminal delivery', () => {
    const messages = [handoff(), { id: 'reply', role: 'ASSISTANT', content: 'listo', files: [{ id: 'audio-1' }] }]
    expect(pendingMediaDeliveryRefreshKey(messages)).not.toBe('')
    expect(pendingMediaDeliveryRefreshKey([{ ...handoff(), role: 'USER' }])).toBe('')
    expect(pendingMediaDeliveryRefreshKey([{ id: 'broken', role: 'ASSISTANT', metadata: '{', content: '```agent-task-state\n{\n```' }])).toBe('')
  })

  it('allows an old stop-reason-only handoff to finish on a subsequent service delivery', () => {
    const messages = [{ id: 'legacy', role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: { stoppedReason: 'media_delivery_handoff' } }]
    expect(pendingMediaDeliveryRefreshKey(messages)).not.toBe('')
    expect(pendingMediaDeliveryRefreshKey([...messages, delivery()])).toBe('')
  })

  it('settles a failed transcription published by media-delivery without requiring artifacts', () => {
    const failed = { ...delivery(), content: 'No pude transcribir el audio.', metadata: {
      source: 'media-delivery', mediaDelivery: 'md_current', transcriptionFileIds: ['audio-1'],
      stoppedReason: 'media_batch_failed', mediaBatch: { total: 1, failed: 1, ready: 0, partial: 0, pending: 0 }, artifacts: [],
    } }
    expect(pendingMediaDeliveryRefreshKey([handoff(), failed])).toBe('')
  })
})

describe('merging out-of-band media delivery', () => {
  it('retains an already visible delivery and its position across a stale chat refresh', () => {
    const later = { id: 'later-user', role: 'USER', content: 'Resume el texto' }
    const local = { id: 'chat', messages: [handoff(), delivery(), later] }
    const stale = { id: 'chat', messages: [handoff(), later] }
    const merged = mergeChatPreservingUserMessages(stale, local)
    expect(merged.messages.map(message => message.id)).toEqual(local.messages.map(message => message.id))
    expect(merged.messages).toContainEqual(delivery())
    expect(pendingMediaDeliveryRefreshKey(merged.messages)).toBe('')
    expect(stale.messages).toHaveLength(2)
    // A server echo of the same delivery must not duplicate the restored row.
    expect(mergeChatPreservingUserMessages(local, merged).messages).toHaveLength(3)
  })

  it('keeps both a new delivery and a longer optimistic reply without mixing contents or files', () => {
    const localReply = { id: 'msg-ai-new', role: 'ASSISTANT', content: 'Una respuesta posterior mucho más larga que la transcripción.',
      metadata: { idempotencyKey: 'new-turn' }, files: [{ id: 'unrelated-file' }] }
    const local = { id: 'chat', messages: [handoff(), { id: 'msg-user-new', role: 'USER', content: 'Otra pregunta' }, localReply] }
    const merged = mergeChatPreservingUserMessages({ id: 'chat', messages: [handoff(), delivery()] }, local)
    expect(merged.messages).toContainEqual(localReply)
    expect(merged.messages.find(message => message.id === delivery().id)).toEqual(delivery())
    expect(merged.messages.filter(message => message.role === 'USER')).toHaveLength(1)
  })

  it('does not copy a previous delivery into a different one or shift normal reply ordinals', () => {
    const old = { ...delivery('md_old'), content: 'Texto anterior con muchas más palabras que no debe reemplazar la entrega nueva.', files: [{ id: 'old-file' }] }
    const previousReply = { id: 'reply', role: 'ASSISTANT', content: 'Otra respuesta larga que se conserva durante su persistencia.' }
    const incomingReply = { ...previousReply, content: '' }
    const merged = mergeChatPreservingUserMessages({ id: 'chat', messages: [handoff(), delivery(), incomingReply] },
      { id: 'chat', messages: [handoff(), old, previousReply] })
    expect(merged.messages.find(message => message.id === delivery().id)).toEqual(delivery())
    expect(merged.messages.find(message => message.id === previousReply.id)?.content).toBe(previousReply.content)
  })
})
