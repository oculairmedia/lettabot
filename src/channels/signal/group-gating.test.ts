import { describe, expect, it } from 'vitest';
import { applySignalGroupGating } from './group-gating.js';

describe('applySignalGroupGating', () => {
  const selfPhoneNumber = '+15551234567';
  const selfUuid = 'abc-123-uuid';

  describe('requireMention: true (default)', () => {
    it('filters messages without mention', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'test-group',
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('allows messages with native mention matching phone', () => {
      const result = applySignalGroupGating({
        text: 'Hey @bot',
        groupId: 'test-group',
        mentions: [{ number: '+15551234567', start: 4, length: 4 }],
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(true);
      expect(result.method).toBe('native');
    });

    it('allows messages with native mention matching UUID', () => {
      const result = applySignalGroupGating({
        text: 'Hey @bot',
        groupId: 'test-group',
        mentions: [{ uuid: selfUuid, start: 4, length: 4 }],
        selfPhoneNumber,
        selfUuid,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('native');
    });

    it('filters when mentions exist for others', () => {
      const result = applySignalGroupGating({
        text: 'Hey @alice',
        groupId: 'test-group',
        mentions: [{ number: '+19998887777', start: 4, length: 6 }],
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });

    it('allows messages matching regex pattern', () => {
      const result = applySignalGroupGating({
        text: '@lettabot what time is it?',
        groupId: 'test-group',
        selfPhoneNumber,
        mentionPatterns: ['@lettabot', '@bot'],
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('regex');
    });

    it('allows replies to bot', () => {
      const result = applySignalGroupGating({
        text: 'Thanks for that!',
        groupId: 'test-group',
        quote: { author: '+15551234567', text: 'Previous message' },
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('reply');
    });

    it('allows messages containing phone number (E.164 fallback)', () => {
      const result = applySignalGroupGating({
        text: 'Hey 15551234567 check this out',
        groupId: 'test-group',
        selfPhoneNumber,
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.method).toBe('e164');
    });
  });

  describe('requireMention: false', () => {
    it('allows all messages when requireMention is false for group', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'test-group',
        selfPhoneNumber,
        groupsConfig: {
          'test-group': { requireMention: false },
        },
      });

      expect(result.shouldProcess).toBe(true);
      expect(result.wasMentioned).toBe(false);
    });

    it('allows all messages when wildcard has requireMention: false', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'random-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: false },
        },
      });

      expect(result.shouldProcess).toBe(true);
    });

    it('specific group config overrides wildcard', () => {
      const result = applySignalGroupGating({
        text: 'Hello everyone!',
        groupId: 'special-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: false },
          'special-group': { requireMention: true },
        },
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('mention-required');
    });
  });

  describe('group allowlist', () => {
    it('filters messages from groups not in allowlist', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'unknown-group',
        selfPhoneNumber,
        groupsConfig: {
          'allowed-group': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('group-not-in-allowlist');
    });

    it('allows messages from groups in allowlist', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'allowed-group',
        selfPhoneNumber,
        groupsConfig: {
          'allowed-group': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(true);
    });

    it('wildcard allows all groups', () => {
      const result = applySignalGroupGating({
        text: '@bot hello',
        groupId: 'any-group',
        selfPhoneNumber,
        groupsConfig: {
          '*': { requireMention: true },
        },
        mentionPatterns: ['@bot'],
      });

      expect(result.shouldProcess).toBe(true);
    });
  });
});
