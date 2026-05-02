import { describe, expect, it, vi } from 'vitest';
import { stripEnvelope, guardOutbound } from './envelope-guard.js';
import {
  formatMessageEnvelope,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from './formatter.js';
import type { InboundMessage } from './types.js';

function fakeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'matrix',
    chatId: '!room:matrix.example.com',
    userId: '@user:matrix.example.com',
    text: 'Hello bot',
    timestamp: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  };
}

describe('stripEnvelope', () => {
  it('returns text unchanged when no envelope is present', () => {
    const result = stripEnvelope('Plain assistant reply, no markers.');
    expect(result.text).toBe('Plain assistant reply, no markers.');
    expect(result.blockMatches).toBe(0);
    expect(result.tagMatches).toBe(0);
  });

  it('handles empty input', () => {
    const result = stripEnvelope('');
    expect(result.text).toBe('');
    expect(result.blockMatches).toBe(0);
    expect(result.tagMatches).toBe(0);
  });

  it('strips a complete envelope block produced by formatMessageEnvelope', () => {
    const formatted = formatMessageEnvelope(fakeMsg({ text: 'Hi!' }));
    // Sanity: the formatter actually emitted a system-reminder block.
    expect(formatted).toContain(SYSTEM_REMINDER_OPEN);
    expect(formatted).toContain(SYSTEM_REMINDER_CLOSE);

    // Simulate the leak: agent reply that includes the envelope above
    // its actual message.
    const leaked = `${formatted}\n\nSure, here is my reply.`;
    const result = stripEnvelope(leaked);

    expect(result.text).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(result.text).not.toContain(SYSTEM_REMINDER_CLOSE);
    expect(result.text).not.toContain('## Message Metadata');
    // The body the formatter placed *outside* the tag (msg.text) and the
    // appended assistant reply both survive.
    expect(result.text).toContain('Hi!');
    expect(result.text).toContain('Sure, here is my reply.');
    expect(result.blockMatches).toBe(1);
  });

  it('strips multiple envelope blocks in a single payload', () => {
    const env1 = formatMessageEnvelope(fakeMsg({ chatId: 'a', text: 'one' }));
    const env2 = formatMessageEnvelope(fakeMsg({ chatId: 'b', text: 'two' }));
    const blob = `prefix\n${env1}\nmiddle\n${env2}\nsuffix`;

    const result = stripEnvelope(blob);

    expect(result.blockMatches).toBe(2);
    expect(result.text).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(result.text).toContain('prefix');
    expect(result.text).toContain('middle');
    expect(result.text).toContain('suffix');
  });

  it('removes orphan open or close tags as a defensive sweep', () => {
    const orphanOpen = `Reply ${SYSTEM_REMINDER_OPEN} no closer`;
    const r1 = stripEnvelope(orphanOpen);
    expect(r1.text).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(r1.tagMatches).toBe(1);

    const orphanClose = `Reply ${SYSTEM_REMINDER_CLOSE} no opener`;
    const r2 = stripEnvelope(orphanClose);
    expect(r2.text).not.toContain(SYSTEM_REMINDER_CLOSE);
    expect(r2.tagMatches).toBe(1);
  });

  it('collapses excess blank lines created by removing a mid-text block', () => {
    const env = formatMessageEnvelope(fakeMsg());
    const blob = `Top line\n\n${env}\n\nBottom line`;
    const result = stripEnvelope(blob);
    expect(result.text).not.toMatch(/\n{3,}/);
    expect(result.text).toContain('Top line');
    expect(result.text).toContain('Bottom line');
  });
});

describe('guardOutbound', () => {
  it('passes clean text through without invoking the warn logger', () => {
    const warn = vi.fn();
    const out = guardOutbound('Just a normal reply.', warn);
    expect(out).toBe('Just a normal reply.');
    expect(warn).not.toHaveBeenCalled();
  });

  it('strips and emits a single warning when an envelope is found', () => {
    const warn = vi.fn();
    const env = formatMessageEnvelope(fakeMsg({ text: 'Hi!' }));
    const out = guardOutbound(`${env}\n\nReply.`, warn);
    expect(out).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(out).toContain('Reply.');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('lettabot-y4j');
  });

  it('survives an empty input without throwing', () => {
    const warn = vi.fn();
    expect(guardOutbound('', warn)).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is safe to call without a logger', () => {
    const env = formatMessageEnvelope(fakeMsg({ text: 'Hi!' }));
    const out = guardOutbound(`${env}\nReply.`);
    expect(out).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(out).toContain('Reply.');
  });
});
