export type StreamBuffer = {
  append: (chunk: string) => void;
  flush: () => void;
  dispose: () => void;
};

type CreateOpts = {
  onFlush: (joined: string) => void;
};

const hasRAF =
  typeof window !== 'undefined' &&
  typeof window.requestAnimationFrame === 'function';

export function createStreamBuffer({ onFlush }: CreateOpts): StreamBuffer {
  let queue: string[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelScheduled = () => {
    if (rafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const flushNow = () => {
    cancelScheduled();
    if (queue.length === 0) return;
    const joined = queue.join('');
    queue = [];
    try {
      onFlush(joined);
    } catch {
      // swallow — the caller's setState should not break the stream
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (rafId !== null || timerId !== null) return;

    // Use rAF when the tab is visible so flushes are aligned to paint.
    // Fall back to setTimeout(16) when the tab is hidden (browsers
    // throttle rAF to seconds in background), otherwise the buffer
    // would stall and the user would see a wall of text on return.
    const inBackground =
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    if (hasRAF && !inBackground) {
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        flushNow();
      });
    } else {
      timerId = setTimeout(() => {
        timerId = null;
        flushNow();
      }, 16);
    }
  };

  return {
    append(chunk: string) {
      if (disposed || !chunk) return;
      queue.push(chunk);
      schedule();
    },
    flush() {
      flushNow();
    },
    dispose() {
      disposed = true;
      cancelScheduled();
      queue = [];
    },
  };
}
