import { describe, it, expect, afterEach } from 'vitest';

import {
  extractAudioMeta,
  extractVideoMeta,
  formatMediaDuration,
  buildPeakBars,
} from '../../lib/attachments/media-meta';

const globalRecord = globalThis as Record<string, unknown>;

function makeFakeFile(bytes = 16): File {
  return {
    name: 'fake.bin',
    type: 'application/octet-stream',
    size: bytes,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  } as unknown as File;
}

afterEach(() => {
  // Make sure stubbed Web Audio globals never leak across tests.
  delete globalRecord.AudioContext;
  delete globalRecord.webkitAudioContext;
  delete globalRecord.OfflineAudioContext;
  delete globalRecord.webkitOfflineAudioContext;
});

describe('extractAudioMeta', () => {
  it('resolves null gracefully in jsdom (no AudioContext)', async () => {
    expect(globalRecord.AudioContext).toBeUndefined();
    expect(globalRecord.OfflineAudioContext).toBeUndefined();

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.mp3', { type: 'audio/mpeg' });
    await expect(extractAudioMeta(file)).resolves.toBeNull();
  });

  it('resolves null within the timeout when decodeAudioData never settles', async () => {
    let closed = false;
    class HangingAudioContext {
      decodeAudioData(): Promise<never> {
        return new Promise<never>(() => {
          /* never settles */
        });
      }
      close(): Promise<void> {
        closed = true;
        return Promise.resolve();
      }
    }
    globalRecord.AudioContext = HangingAudioContext;

    const start = Date.now();
    const result = await extractAudioMeta(makeFakeFile(), { timeoutMs: 50 });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(closed).toBe(true);
  });

  it('resolves null when decodeAudioData rejects', async () => {
    class RejectingAudioContext {
      decodeAudioData(): Promise<never> {
        return Promise.reject(new Error('bad data'));
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    globalRecord.AudioContext = RejectingAudioContext;

    await expect(extractAudioMeta(makeFakeFile(), { timeoutMs: 200 })).resolves.toBeNull();
  });

  it('computes duration and normalized peaks with a working stub, and closes the context', async () => {
    const channel = new Float32Array(400);
    for (let i = 0; i < 200; i++) channel[i] = 0.5;
    for (let i = 200; i < 400; i++) channel[i] = i % 2 === 0 ? -1 : 1;

    let closed = false;
    class WorkingAudioContext {
      decodeAudioData(): Promise<unknown> {
        return Promise.resolve({
          duration: 2,
          length: 400,
          sampleRate: 200,
          numberOfChannels: 1,
          getChannelData: () => channel,
        });
      }
      close(): Promise<void> {
        closed = true;
        return Promise.resolve();
      }
    }
    globalRecord.AudioContext = WorkingAudioContext;

    const result = await extractAudioMeta(makeFakeFile(), { buckets: 2, timeoutMs: 1000 });
    expect(result).not.toBeNull();
    if (!result) throw new Error('unreachable');
    expect(result.durationSeconds).toBe(2);
    expect(result.peaks).toEqual([0.5, 1]);
    expect(closed).toBe(true);
  });
});

describe('extractVideoMeta', () => {
  it('resolves null gracefully in jsdom (no URL.createObjectURL / canvas)', async () => {
    const file = new File([new Uint8Array([0, 0, 0, 1])], 'clip.mp4', { type: 'video/mp4' });
    await expect(extractVideoMeta(file, { timeoutMs: 100 })).resolves.toBeNull();
  });
});

describe('formatMediaDuration', () => {
  it('formats sub-minute durations with a zero minute', () => {
    expect(formatMediaDuration(7)).toBe('0:07');
    expect(formatMediaDuration(0)).toBe('0:00');
    expect(formatMediaDuration(59)).toBe('0:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatMediaDuration(222)).toBe('3:42');
    expect(formatMediaDuration(60)).toBe('1:00');
  });

  it('formats hour-long durations with padded minutes and seconds', () => {
    expect(formatMediaDuration(3729)).toBe('1:02:09');
    expect(formatMediaDuration(3600)).toBe('1:00:00');
    expect(formatMediaDuration(7322)).toBe('2:02:02');
  });

  it('floors fractional seconds and clamps invalid input to 0:00', () => {
    expect(formatMediaDuration(7.9)).toBe('0:07');
    expect(formatMediaDuration(-5)).toBe('0:00');
    expect(formatMediaDuration(Number.NaN)).toBe('0:00');
    expect(formatMediaDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('buildPeakBars', () => {
  it('returns an empty array for empty input', () => {
    expect(buildPeakBars([], 40)).toEqual([]);
  });

  it('maps normalized peaks to integer pixel heights', () => {
    expect(buildPeakBars([1, 0.5, 0.25], 40)).toEqual([40, 20, 10]);
  });

  it('clamps tiny and zero peaks to the 2px minimum', () => {
    expect(buildPeakBars([0, 0.01], 40)).toEqual([2, 2]);
  });

  it('clamps out-of-range and invalid peaks', () => {
    expect(buildPeakBars([2, -1, Number.NaN], 40)).toEqual([40, 2, 2]);
  });

  it('stays at the minimum height when height is tiny or invalid', () => {
    expect(buildPeakBars([1, 0.5], 1)).toEqual([2, 2]);
    expect(buildPeakBars([1], Number.NaN)).toEqual([2]);
  });
});
