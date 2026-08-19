/**
 * server/intelligence/core/streamer.ts
 *
 * Default Streamer — emits Server-Sent Events in the exact wire shape the rest
 * of SiraGPT already speaks:
 *   - token frames:   data: {"content":"..."}\n\n
 *   - replace frames: data: {"replace":true,"content":"..."}\n\n
 *   - control frames: data: {"type":"start|heartbeat|usage|error|meta", ...}\n\n
 *   - terminal:       data: [DONE]\n\n
 *
 * It is sink-agnostic (works over an Express `res`, a string buffer, or any
 * object exposing `write`). Back-pressure-aware when the sink's `write`
 * returns a promise.
 */

import type { StreamEvent, StreamSink, Streamer } from '../ports';

const DONE_SENTINEL = 'data: [DONE]\n\n';

async function writeFrame(sink: StreamSink, payload: string): Promise<void> {
  const out = sink.write(payload);
  if (out && typeof (out as Promise<void>).then === 'function') {
    await out;
  }
}

function frameFor(event: StreamEvent): string {
  switch (event.type) {
    case 'token':
      return `data: ${JSON.stringify({ content: event.content ?? '' })}\n\n`;
    case 'replace':
      return `data: ${JSON.stringify({ replace: true, content: event.content ?? '' })}\n\n`;
    case 'heartbeat':
      // SSE comment heartbeat keeps intermediaries from closing the stream.
      return `: ping ${Date.now()}\n\n`;
    case 'done':
      return DONE_SENTINEL;
    default: {
      const body: Record<string, unknown> = { type: event.type };
      if (event.content != null) body.content = event.content;
      if (event.data) Object.assign(body, event.data);
      return `data: ${JSON.stringify(body)}\n\n`;
    }
  }
}

export interface DefaultStreamerOptions {
  /** When true, emit a `meta`/control frame's JSON even for token frames. */
  readonly verbose?: boolean;
}

export function createDefaultStreamer(
  _options: DefaultStreamerOptions = {}
): Streamer {
  async function emit(sink: StreamSink, event: StreamEvent): Promise<void> {
    await writeFrame(sink, frameFor(event));
  }

  async function token(sink: StreamSink, text: string): Promise<void> {
    if (!text) return;
    await writeFrame(sink, frameFor({ type: 'token', content: text }));
  }

  async function done(sink: StreamSink): Promise<void> {
    await writeFrame(sink, DONE_SENTINEL);
    if (typeof sink.end === 'function') {
      try {
        sink.end();
      } catch {
        /* sink already closed — ignore */
      }
    }
  }

  return { emit, token, done };
}

/** A simple in-memory sink, handy for tests and the eval harness. */
export function createBufferSink(): StreamSink & { frames: string[]; text(): string } {
  const frames: string[] = [];
  return {
    frames,
    write(chunk: string) {
      frames.push(chunk);
    },
    text() {
      // Reconstruct the streamed assistant text from token/replace frames.
      let result = '';
      for (const frame of frames) {
        const m = frame.match(/^data: ([\s\S]+)\n\n$/);
        if (!m) continue;
        if (m[1] === '[DONE]') continue;
        try {
          const obj = JSON.parse(m[1]) as { content?: string; replace?: boolean };
          if (obj.replace) result = obj.content ?? '';
          else if (typeof obj.content === 'string') result += obj.content;
        } catch {
          /* ignore non-JSON frames (comments/heartbeats) */
        }
      }
      return result;
    },
  };
}
