/**
 * Unit tests for BotStreamCoalescer.
 *
 * Covers the 9 cases enumerated in docs/architecture/bot-stream-coalescer.md
 * §4 plus a few additional regressions for the tool_call_id-less branch
 * and dispose semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotStreamCoalescer,
  DEFAULT_COALESCE_WINDOW_MS,
  type StreamFrame,
} from './bot-stream-coalescer.js';

interface Captured {
  flushed: StreamFrame[];
  coalescer: BotStreamCoalescer;
}

function makeCoalescer(windowMs: number = DEFAULT_COALESCE_WINDOW_MS): Captured {
  const flushed: StreamFrame[] = [];
  const coalescer = new BotStreamCoalescer({
    windowMs,
    onFlush: (frame) => flushed.push(frame),
  });
  return { flushed, coalescer };
}

function textFrame(
  event: 'assistant' | 'reasoning',
  content: string,
  request_id = 'req-1',
  uuid?: string,
): StreamFrame {
  return { type: 'stream', event, content, request_id, ...(uuid ? { uuid } : {}) };
}

function toolCallFrame(
  tool_call_id: string,
  partial: Record<string, unknown>,
  request_id = 'req-1',
  status?: 'running' | 'completed' | 'failed' | 'canceled',
): StreamFrame {
  return {
    type: 'stream',
    event: 'tool_call',
    tool_call_id,
    tool_name: 'Read',
    tool_input: partial,
    request_id,
    ...(status ? { status } : {}),
  };
}

function toolResultFrame(tool_call_id: string, content: string, request_id = 'req-1'): StreamFrame {
  return {
    type: 'stream',
    event: 'tool_result',
    tool_call_id,
    tool_name: 'Read',
    content,
    is_error: false,
    request_id,
  };
}

describe('BotStreamCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('text concat (case 1)', () => {
    it('concatenates 10 assistant deltas inside the window into one frame', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      for (let i = 0; i < 10; i++) {
        coalescer.handle(textFrame('assistant', `chunk${i}-`));
      }
      // Nothing emitted yet — still buffering.
      expect(flushed).toHaveLength(0);

      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toMatchObject({
        type: 'stream',
        event: 'assistant',
        content:
          'chunk0-chunk1-chunk2-chunk3-chunk4-chunk5-chunk6-chunk7-chunk8-chunk9-',
        request_id: 'req-1',
      });
    });

    it('keeps the first frame uuid when concatenating', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'a', 'req-1', 'uuid-first'));
      coalescer.handle(textFrame('assistant', 'b', 'req-1', 'uuid-second'));
      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].uuid).toBe('uuid-first');
      expect(flushed[0].content).toBe('ab');
    });
  });

  describe('text split across windows (case 2)', () => {
    it('emits two separate frames when deltas straddle a window boundary', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      for (let i = 0; i < 5; i++) coalescer.handle(textFrame('assistant', 'a'));
      vi.advanceTimersByTime(200);
      // First batch flushed.
      expect(flushed).toHaveLength(1);
      expect(flushed[0].content).toBe('aaaaa');

      vi.advanceTimersByTime(50); // 50ms gap, no new events.
      for (let i = 0; i < 5; i++) coalescer.handle(textFrame('assistant', 'b'));
      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(2);
      expect(flushed[1].content).toBe('bbbbb');
    });
  });

  describe('mixed text + tool ordering (case 3)', () => {
    it('preserves insertion order: text → tool → text → tool_result', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'before-'));
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/a' }, 'req-1', 'running'));
      coalescer.handle(textFrame('assistant', 'after'));
      coalescer.handle(toolResultFrame('tc-1', 'contents'));

      // tool_result triggers immediate flush of pending entries.
      expect(flushed).toHaveLength(4);
      expect(flushed[0].event).toBe('assistant');
      expect(flushed[0].content).toBe('before-');
      expect(flushed[1].event).toBe('tool_call');
      expect(flushed[2].event).toBe('assistant');
      expect(flushed[2].content).toBe('after');
      expect(flushed[3].event).toBe('tool_result');
    });

    it('does NOT merge text deltas separated by a tool_call', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'A'));
      coalescer.handle(toolCallFrame('tc-1', {}, 'req-1', 'running'));
      coalescer.handle(textFrame('assistant', 'B'));
      vi.advanceTimersByTime(200);

      // Three frames: text "A", tool_call, text "B"
      expect(flushed.map((f) => f.event)).toEqual(['assistant', 'tool_call', 'assistant']);
      expect(flushed[0].content).toBe('A');
      expect(flushed[2].content).toBe('B');
    });
  });

  describe('tool_call replace by id (case 4)', () => {
    it('5 running snapshots of the same id collapse to the latest', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/a' }, 'req-1', 'running'));
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/ab' }, 'req-1', 'running'));
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/abc' }, 'req-1', 'running'));
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/abcd' }, 'req-1', 'running'));
      coalescer.handle(toolCallFrame('tc-1', { file_path: '/abcde' }, 'req-1', 'running'));
      vi.advanceTimersByTime(200);

      expect(flushed).toHaveLength(1);
      expect(flushed[0].event).toBe('tool_call');
      expect(flushed[0].tool_input).toEqual({ file_path: '/abcde' });
    });

    it('replace-by-id keeps original insertion position when interleaved with text', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(toolCallFrame('tc-1', { v: 1 }, 'req-1', 'running'));
      coalescer.handle(textFrame('assistant', 'mid'));
      coalescer.handle(toolCallFrame('tc-1', { v: 2 }, 'req-1', 'running'));
      vi.advanceTimersByTime(200);

      // tool_call (latest=v:2) → text "mid"
      expect(flushed).toHaveLength(2);
      expect(flushed[0].event).toBe('tool_call');
      expect(flushed[0].tool_input).toEqual({ v: 2 });
      expect(flushed[1].event).toBe('assistant');
      expect(flushed[1].content).toBe('mid');
    });
  });

  describe('tool terminal status flush (case 5)', () => {
    it('completed status flushes immediately even with timer running', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'thinking-'));
      coalescer.handle(toolCallFrame('tc-1', {}, 'req-1', 'running'));
      // Terminal status should flush right away, no need to wait 200ms.
      coalescer.handle(toolCallFrame('tc-1', { result: 'ok' }, 'req-1', 'completed'));

      expect(flushed).toHaveLength(2);
      expect(flushed[0].event).toBe('assistant');
      expect(flushed[1].event).toBe('tool_call');
      expect(flushed[1].status).toBe('completed');
    });

    it('failed and canceled also flush immediately', () => {
      const { flushed: failedSink, coalescer: failedCo } = makeCoalescer(200);
      failedCo.handle(toolCallFrame('tc-1', {}, 'req-1', 'failed'));
      expect(failedSink).toHaveLength(1);

      const { flushed: cancelSink, coalescer: cancelCo } = makeCoalescer(200);
      cancelCo.handle(toolCallFrame('tc-1', {}, 'req-1', 'canceled'));
      expect(cancelSink).toHaveLength(1);
    });
  });

  describe('tool_result flushes pending (case 6)', () => {
    it('tool_result emits pending text + tool_call in order, then itself', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'pre-'));
      coalescer.handle(toolCallFrame('tc-1', { v: 1 }, 'req-1', 'running'));
      coalescer.handle(toolResultFrame('tc-1', 'value'));

      expect(flushed.map((f) => f.event)).toEqual(['assistant', 'tool_call', 'tool_result']);
    });
  });

  describe('per-request isolation (case 7)', () => {
    it('two interleaved request_ids flush independently', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'A1', 'req-A'));
      coalescer.handle(textFrame('assistant', 'B1', 'req-B'));
      coalescer.handle(textFrame('assistant', 'A2', 'req-A'));
      coalescer.handle(textFrame('assistant', 'B2', 'req-B'));
      vi.advanceTimersByTime(200);

      // Both timers fire at the same tick → 2 flushed frames, but their
      // contents are independent.
      expect(flushed).toHaveLength(2);
      const reqA = flushed.find((f) => f.request_id === 'req-A')!;
      const reqB = flushed.find((f) => f.request_id === 'req-B')!;
      expect(reqA.content).toBe('A1A2');
      expect(reqB.content).toBe('B1B2');
    });

    it('flushFor flushes only the targeted request', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'A', 'req-A'));
      coalescer.handle(textFrame('assistant', 'B', 'req-B'));

      coalescer.flushFor('req-A');
      expect(flushed).toHaveLength(1);
      expect(flushed[0].request_id).toBe('req-A');

      coalescer.flushFor('req-B');
      expect(flushed).toHaveLength(2);
      expect(flushed[1].request_id).toBe('req-B');
    });
  });

  describe('abort/cancel semantics (case 8)', () => {
    it('flushAndDiscard drops buffered entries without emitting', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'lost-'));
      coalescer.handle(toolCallFrame('tc-1', { v: 1 }, 'req-1', 'running'));

      coalescer.flushAndDiscard('req-1');
      expect(flushed).toHaveLength(0);
      expect(coalescer.pendingRequestCount()).toBe(0);

      // Later events for a fresh request_id work normally.
      coalescer.handle(textFrame('assistant', 'fresh', 'req-2'));
      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].content).toBe('fresh');
    });

    it('dispose flushes everything and prevents further buffering', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'a'));
      coalescer.handle(textFrame('assistant', 'b'));
      coalescer.dispose();

      // Pending was flushed.
      expect(flushed).toHaveLength(1);
      expect(flushed[0].content).toBe('ab');

      // Post-dispose: pass-through (no buffering).
      coalescer.handle(textFrame('assistant', 'c'));
      expect(flushed).toHaveLength(2);
      expect(flushed[1].content).toBe('c');
    });
  });

  describe('no-event timer no-op (case 9)', () => {
    it('a timer firing on an already-empty buffer does not call onFlush', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'one'));
      // Drain manually.
      coalescer.flushFor('req-1');
      expect(flushed).toHaveLength(1);

      // Advance past the original 200ms timer's deadline. flushFor cleared
      // the timer; onFlush must not fire again.
      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(1);
    });
  });

  describe('extra: tool_call without id', () => {
    it('passes through but flushes pending in order', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'pre-'));
      const noIdFrame: StreamFrame = {
        type: 'stream',
        event: 'tool_call',
        tool_name: 'Anon',
        tool_input: {},
        request_id: 'req-1',
      };
      coalescer.handle(noIdFrame);
      vi.advanceTimersByTime(200);

      expect(flushed.map((f) => f.event)).toEqual(['assistant', 'tool_call']);
    });
  });

  describe('extra: non-stream frames bypass coalescing', () => {
    it('an error frame flushes pending then passes through', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'before-'));
      const errorFrame = {
        type: 'error',
        event: 'whatever',
        code: 'STREAM_ERROR',
        message: 'boom',
        request_id: 'req-1',
      } as unknown as StreamFrame;
      coalescer.handle(errorFrame);

      // Non-stream type triggers immediate pending-flush + pass-through.
      expect(flushed).toHaveLength(2);
      expect(flushed[0].event).toBe('assistant');
      expect(flushed[1].type).toBe('error');
    });
  });

  describe('extra: result frame is not a stream event', () => {
    it('a result frame (type=result) flushes pending and passes through', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'finalword'));
      const resultFrame = {
        type: 'result',
        event: 'result',
        success: true,
        request_id: 'req-1',
      } as unknown as StreamFrame;
      coalescer.handle(resultFrame);

      expect(flushed).toHaveLength(2);
      expect(flushed[0].event).toBe('assistant');
      expect(flushed[1].type).toBe('result');
    });
  });

  describe('extra: flushAll drains every request', () => {
    it('flushAll emits everything and leaves coalescer reusable', () => {
      const { flushed, coalescer } = makeCoalescer(200);
      coalescer.handle(textFrame('assistant', 'A', 'req-A'));
      coalescer.handle(textFrame('assistant', 'B', 'req-B'));
      coalescer.flushAll();

      expect(flushed).toHaveLength(2);
      expect(coalescer.pendingRequestCount()).toBe(0);

      coalescer.handle(textFrame('assistant', 'after', 'req-C'));
      vi.advanceTimersByTime(200);
      expect(flushed).toHaveLength(3);
      expect(flushed[2].request_id).toBe('req-C');
    });
  });
});
