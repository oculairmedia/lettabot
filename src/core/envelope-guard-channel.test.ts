/**
 * Channel-level integration test for the envelope-guard wrapper that
 * `LettaBot.registerChannel` installs around `adapter.sendMessage` and
 * `adapter.editMessage`.
 *
 * Reproduces the lettabot-y4j leak: an outbound payload that contains
 * the inbound `<system-reminder>...</system-reminder>` envelope (because
 * a code path echoed the formatted user input back as bot output, or an
 * agent regurgitated its own prompt) must be sanitized before reaching
 * the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LettaBot } from './bot.js';
import type { OutboundMessage } from './types.js';
import type { ChannelAdapter } from '../channels/types.js';
import {
  formatMessageEnvelope,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from './formatter.js';

describe('channel envelope-guard wrapping (lettabot-y4j)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-envelope-guard-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeAdapter(sendSpy: (msg: OutboundMessage) => Promise<{ messageId: string }>): ChannelAdapter {
    return {
      id: 'mock',
      name: 'Mock',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: sendSpy as ChannelAdapter['sendMessage'],
      editMessage: vi.fn(async () => {}),
      sendTypingIndicator: vi.fn(async () => {}),
      getFormatterHints: () => ({ supportsReactions: false, supportsFiles: false }),
    };
  }

  it('strips a leaked system-reminder envelope from sendMessage payloads', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      // Disable redaction so we're testing the guard in isolation.
      redaction: { secrets: false, pii: false },
    });

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent-1' }));
    const adapter = makeAdapter(sendSpy);
    bot.registerChannel(adapter);

    // Construct a leaked payload: a real envelope produced by the
    // formatter, followed by the assistant's actual reply.
    const leakedEnvelope = formatMessageEnvelope({
      channel: 'matrix',
      chatId: '!room:matrix.example.com',
      userId: '@user:matrix.example.com',
      text: 'hello bot',
      timestamp: new Date('2026-04-27T00:00:00Z'),
    });
    const payload = `${leakedEnvelope}\n\nHello! How can I help?`;

    await adapter.sendMessage({ chatId: 'chat-1', text: payload });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0];

    // The envelope is gone.
    expect(sent.text).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(sent.text).not.toContain(SYSTEM_REMINDER_CLOSE);
    expect(sent.text).not.toContain('## Message Metadata');
    expect(sent.text).not.toContain('## Chat Context');
    // The actual assistant content survives.
    expect(sent.text).toContain('Hello! How can I help?');
  });

  it('strips a leaked envelope from editMessage payloads', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: false },
    });

    const editSpy = vi.fn(async (_chatId: string, _messageId: string, _text: string) => {});
    const adapter: ChannelAdapter = {
      ...makeAdapter(vi.fn(async () => ({ messageId: 'sent-1' }))),
      editMessage: editSpy,
    };
    bot.registerChannel(adapter);

    const env = formatMessageEnvelope({
      channel: 'matrix',
      chatId: '!room:matrix.example.com',
      userId: '@user:matrix.example.com',
      text: 'edit me',
      timestamp: new Date('2026-04-27T00:00:00Z'),
    });
    const editText = `${env}\n\nUpdated reply.`;

    await adapter.editMessage('chat-1', 'msg-id', editText);

    expect(editSpy).toHaveBeenCalledTimes(1);
    const editedText = editSpy.mock.calls[0][2];
    expect(editedText).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(editedText).toContain('Updated reply.');
  });

  it('passes clean text through untouched (no false positives)', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: false },
    });

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent-1' }));
    const adapter = makeAdapter(sendSpy);
    bot.registerChannel(adapter);

    const clean = 'Hello! Here is some normal text with code: `<system-something/>` is fine.';
    await adapter.sendMessage({ chatId: 'chat-1', text: clean });

    expect(sendSpy.mock.calls[0][0].text).toBe(clean);
  });

  it('stacks correctly with redaction (secrets stripped before envelope guard)', async () => {
    // Compose redaction + envelope-guard. A leaked envelope that
    // contains a secret should both have the envelope removed and the
    // secret redacted in surrounding content.
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: true, pii: false },
    });

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent-1' }));
    const adapter = makeAdapter(sendSpy);
    bot.registerChannel(adapter);

    const env = formatMessageEnvelope({
      channel: 'matrix',
      chatId: '!room:matrix.example.com',
      userId: '@user:matrix.example.com',
      text: 'hi',
      timestamp: new Date('2026-04-27T00:00:00Z'),
    });
    const payload = `${env}\n\nReply with key sk-abc123def456ghi789jkl012mno345 attached.`;

    await adapter.sendMessage({ chatId: 'chat-1', text: payload });

    const sent = sendSpy.mock.calls[0][0];
    expect(sent.text).not.toContain(SYSTEM_REMINDER_OPEN);
    expect(sent.text).not.toContain('sk-abc123def456ghi789jkl012mno345');
    expect(sent.text).toContain('[REDACTED]');
    expect(sent.text).toContain('Reply with key');
  });
});
