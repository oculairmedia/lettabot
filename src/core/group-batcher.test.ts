import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupBatcher } from './group-batcher.js';
import type { InboundMessage } from './types.js';
import type { ChannelAdapter } from '../channels/types.js';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'discord',
    chatId: 'group-123',
    userId: 'user-1',
    userName: 'Alice',
    text: 'hello',
    timestamp: new Date(),
    isGroup: true,
    wasMentioned: false,
    ...overrides,
  };
}

const mockAdapter = {} as ChannelAdapter;

describe('GroupBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately on @mention', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg({ wasMentioned: true }), mockAdapter, 5000);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].text).toBe('hello');
  });

  it('flushes immediately when debounceMs is 0', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg(), mockAdapter, 0);

    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('debounces: resets timer on new messages', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    // First message starts 5s timer
    batcher.enqueue(makeMsg({ text: 'msg1' }), mockAdapter, 5000);
    expect(onFlush).not.toHaveBeenCalled();

    // 3 seconds later, second message resets timer
    vi.advanceTimersByTime(3000);
    batcher.enqueue(makeMsg({ text: 'msg2' }), mockAdapter, 5000);
    expect(onFlush).not.toHaveBeenCalled();

    // 3 more seconds (6s total from first msg, 3s from second) -- still not flushed
    vi.advanceTimersByTime(3000);
    expect(onFlush).not.toHaveBeenCalled();

    // 2 more seconds (5s from second message) -- now flushes
    vi.advanceTimersByTime(2000);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Both messages batched together
    const flushed = onFlush.mock.calls[0][0] as InboundMessage;
    expect(flushed.text).toBe('msg1\nmsg2');
    expect(flushed.isBatch).toBe(true);
    expect(flushed.batchedMessages).toHaveLength(2);
  });

  it('flushes after quiet period with single message', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg({ text: 'solo' }), mockAdapter, 5000);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].text).toBe('solo');
  });

  it('mention flushes all buffered messages including non-mentioned', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg({ text: 'msg1' }), mockAdapter, 5000);
    batcher.enqueue(makeMsg({ text: 'msg2' }), mockAdapter, 5000);
    batcher.enqueue(makeMsg({ text: '@bot help', wasMentioned: true }), mockAdapter, 5000);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const flushed = onFlush.mock.calls[0][0] as InboundMessage;
    expect(flushed.text).toBe('msg1\nmsg2\n@bot help');
    expect(flushed.wasMentioned).toBe(true);
  });

  it('isolates buffers by channel:chatId', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg({ chatId: 'group-A', text: 'A1' }), mockAdapter, 5000);
    batcher.enqueue(makeMsg({ chatId: 'group-B', text: 'B1' }), mockAdapter, 5000);

    // Flush group A via mention
    batcher.enqueue(makeMsg({ chatId: 'group-A', text: 'A2', wasMentioned: true }), mockAdapter, 5000);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].text).toBe('A1\nA2');

    // Group B still buffered, flushes on timeout
    vi.advanceTimersByTime(5000);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1][0].text).toBe('B1');
  });

  it('stop() clears all timers and buffers', () => {
    const onFlush = vi.fn();
    const batcher = new GroupBatcher(onFlush);

    batcher.enqueue(makeMsg(), mockAdapter, 5000);
    batcher.stop();

    vi.advanceTimersByTime(10000);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
