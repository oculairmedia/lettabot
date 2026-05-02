import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundObserver, hashText } from './outbound-observer.js';

describe('hashText', () => {
  it('returns a 16-char lowercase hex digest', () => {
    const h = hashText('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls', () => {
    expect(hashText('foo')).toBe(hashText('foo'));
  });

  it('differs for different inputs', () => {
    expect(hashText('foo')).not.toBe(hashText('bar'));
  });
});

describe('OutboundObserver', () => {
  let logs: string[];
  let warns: string[];
  let clock: number;
  let obs: OutboundObserver;

  beforeEach(() => {
    logs = [];
    warns = [];
    clock = 1_000_000;
    obs = new OutboundObserver({
      windowMs: 5000,
      maxEntries: 4,
      logInfo: (l) => logs.push(l),
      logWarn: (l) => warns.push(l),
      now: () => clock,
    });
  });

  it('emits a structured info log line for every observation', () => {
    obs.observe({ channel: 'matrix', chatId: '!room:srv', text: 'hi', kind: 'send' });
    expect(logs).toHaveLength(1);
    const line = logs[0];
    expect(line).toContain('[outbound]');
    expect(line).toContain('channel=matrix');
    expect(line).toContain('chat=!room:srv');
    expect(line).toContain('kind=send');
    expect(line).toContain('len=2');
    expect(line).toMatch(/text_hash=[0-9a-f]{16}/);
  });

  it('includes edit_msg only for edit kind', () => {
    obs.observe({
      channel: 'matrix',
      chatId: 'c',
      text: 'hi',
      kind: 'edit',
      editMessageId: '$abc',
    });
    expect(logs[0]).toContain('edit_msg=$abc');

    logs.length = 0;
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'hi', kind: 'send' });
    expect(logs[0]).not.toContain('edit_msg=');
  });

  it('does NOT warn on first send', () => {
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'hello', kind: 'send' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('warns on a same-text send to the same chat within the window', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'hello', kind: 'send' });
    clock += 1500;
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'hello', kind: 'send' });
    expect(r.duplicate).toBe(true);
    expect(r.sinceMs).toBe(1500);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('[outbound-dup]');
    expect(warns[0]).toContain('within 1500ms');
    expect(warns[0]).toContain('lettabot-y4j');
  });

  it('does NOT warn when the window has elapsed', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'hello', kind: 'send' });
    clock += 6000; // > 5000ms window
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'hello', kind: 'send' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('treats different chats as independent', () => {
    obs.observe({ channel: 'matrix', chatId: 'a', text: 'x', kind: 'send' });
    const r = obs.observe({ channel: 'matrix', chatId: 'b', text: 'x', kind: 'send' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('treats different channels as independent', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    const r = obs.observe({ channel: 'discord', chatId: 'c', text: 'x', kind: 'send' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('treats send vs edit with same text as independent', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'edit' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('does not warn for empty text even if repeated', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: '', kind: 'send' });
    clock += 100;
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: '', kind: 'send' });
    expect(r.duplicate).toBe(false);
    expect(warns).toEqual([]);
  });

  it('refreshes the LRU position so the same hash keeps the dedup window alive', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    clock += 1000;
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    // First repeat warned. Now after another 1s, still within window of *latest* send.
    clock += 1000;
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    expect(r.duplicate).toBe(true);
    expect(r.sinceMs).toBe(1000);
    expect(warns).toHaveLength(2);
  });

  it('evicts oldest entries past maxEntries', () => {
    // maxEntries=4 in beforeEach
    for (let i = 0; i < 6; i++) {
      obs.observe({ channel: 'matrix', chatId: `c${i}`, text: 't', kind: 'send' });
    }
    expect(obs.size()).toBe(4);
    // The first two should have been evicted; resending to c0 must not warn.
    const r = obs.observe({ channel: 'matrix', chatId: 'c0', text: 't', kind: 'send' });
    expect(r.duplicate).toBe(false);
  });

  it('reset() clears state', () => {
    obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    obs.reset();
    const r = obs.observe({ channel: 'matrix', chatId: 'c', text: 'x', kind: 'send' });
    expect(r.duplicate).toBe(false);
  });

  it('uses default options when not provided', () => {
    const silent = new OutboundObserver();
    // No throw, no log capture needed — default loggers are no-ops.
    expect(() => silent.observe({ channel: 'm', chatId: 'c', text: 'x', kind: 'send' })).not.toThrow();
  });
});
