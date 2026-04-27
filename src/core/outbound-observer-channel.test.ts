/**
 * Channel-level integration test for the OutboundObserver wiring that
 * `LettaBot.registerChannel` installs around `adapter.sendMessage` and
 * `adapter.editMessage`.
 *
 * Tracking: lettabot-y4j Phase 2 (doubled-messages diagnostic).
 *
 * Verifies:
 *   - every wrapped send/edit produces a structured `[outbound]` info log,
 *   - a near-duplicate send to the same chat produces an `[outbound-dup]`
 *     warn referencing lettabot-y4j,
 *   - sends to different chats / different channels do not warn,
 *   - the underlying adapter still receives the (sanitized) payload.
 *
 * Implementation note: rather than capture pino's transport output (which
 * is async / worker-threaded and brittle to test against), we capture
 * observer log lines directly by replacing the bot's observer hooks via
 * the `__outboundObserverForTest` test seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LettaBot } from './bot.js';
import type { ChannelId, OutboundMessage } from './types.js';
import type { ChannelAdapter } from '../channels/types.js';
import { OutboundObserver } from './outbound-observer.js';

describe('channel outbound-observer wiring (lettabot-y4j Phase 2)', () => {
  let workDir: string;
  let infoLines: string[];
  let warnLines: string[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lettabot-outbound-obs-'));
    infoLines = [];
    warnLines = [];
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Swap the bot's observer for one whose hooks we control directly. */
  function instrument(bot: LettaBot): void {
    const test = new OutboundObserver({
      logInfo: (line) => infoLines.push(line),
      logWarn: (line) => warnLines.push(line),
    });
    // Replace the observer fields used inside the wrapped sendMessage /
    // editMessage closures. The wrappers capture `this.outboundObserver`
    // at registerChannel-time, so we substitute its instance methods.
    const real = bot.__outboundObserverForTest;
    real.observe = test.observe.bind(test);
    real.reset = test.reset.bind(test);
    (real as unknown as { size: () => number }).size = test.size.bind(test);
  }

  function makeAdapter(
    sendSpy: (msg: OutboundMessage) => Promise<{ messageId: string }>,
    editSpy: (chatId: string, messageId: string, text: string) => Promise<void> = vi.fn(async () => {}),
    id: ChannelId = 'mock',
  ): ChannelAdapter {
    return {
      id,
      name: `Mock-${id}`,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
      sendMessage: sendSpy as ChannelAdapter['sendMessage'],
      editMessage: editSpy as ChannelAdapter['editMessage'],
      sendTypingIndicator: vi.fn(async () => {}),
      getFormatterHints: () => ({ supportsReactions: false, supportsFiles: false }),
    };
  }

  it('emits [outbound] info logs for sendMessage and editMessage', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: false },
    });
    instrument(bot);

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent-1' }));
    const editSpy = vi.fn(async (_chatId: string, _messageId: string, _text: string) => {});
    const adapter = makeAdapter(sendSpy, editSpy);
    bot.registerChannel(adapter);

    await adapter.sendMessage({ chatId: 'chat-1', text: 'hello world' });
    await adapter.editMessage('chat-1', 'msg-1', 'updated reply');

    const infoText = infoLines.join('\n');
    expect(infoText).toMatch(/\[outbound\] channel=mock chat=chat-1 kind=send len=11 text_hash=[0-9a-f]{16}/);
    expect(infoText).toMatch(/\[outbound\] channel=mock chat=chat-1 kind=edit len=13 text_hash=[0-9a-f]{16} edit_msg=msg-1/);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(editSpy).toHaveBeenCalledTimes(1);
  });

  it('warns [outbound-dup] when the same text is sent twice in a row to the same chat', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: false },
    });
    instrument(bot);

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent' }));
    const adapter = makeAdapter(sendSpy);
    bot.registerChannel(adapter);

    await adapter.sendMessage({ chatId: 'chat-1', text: 'doubled message body' });
    await adapter.sendMessage({ chatId: 'chat-1', text: 'doubled message body' });

    const warnText = warnLines.join('\n');
    expect(warnText).toContain('[outbound-dup]');
    expect(warnText).toContain('lettabot-y4j');
    expect(warnText).toContain('chat=chat-1');

    // The bug-localiser is a passive observer — both sends must still
    // hit the wire (we do NOT drop, we only flag).
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('does not warn for distinct texts, distinct chats, or distinct kinds', async () => {
    const bot = new LettaBot({
      workingDir: workDir,
      allowedTools: [],
      redaction: { secrets: false, pii: false },
    });
    instrument(bot);

    const sendSpy = vi.fn(async (_msg: OutboundMessage) => ({ messageId: 'sent' }));
    const editSpy = vi.fn(async () => {});
    const adapter = makeAdapter(sendSpy, editSpy);
    bot.registerChannel(adapter);

    await adapter.sendMessage({ chatId: 'a', text: 'alpha' });
    await adapter.sendMessage({ chatId: 'a', text: 'beta' });          // diff text
    await adapter.sendMessage({ chatId: 'b', text: 'alpha' });          // diff chat
    await adapter.editMessage('a', 'm1', 'alpha');                      // diff kind, same text+chat

    expect(warnLines.join('\n')).not.toContain('[outbound-dup]');
  });
});
