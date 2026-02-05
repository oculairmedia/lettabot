/**
 * Signal Group Gating
 *
 * Filters group messages based on mention detection.
 * Only processes messages where the bot is mentioned (unless requireMention: false).
 */

export interface SignalGroupConfig {
  requireMention?: boolean;  // Default: true
}

export interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
}

export interface SignalQuote {
  id?: number;
  author?: string;
  authorUuid?: string;
  text?: string;
}

export interface SignalGroupGatingParams {
  /** Message text */
  text: string;
  
  /** Group ID (without "group:" prefix) */
  groupId: string;
  
  /** Native Signal mentions from the message */
  mentions?: SignalMention[];
  
  /** Quote/reply info if replying to a message */
  quote?: SignalQuote;
  
  /** Bot's phone number (E.164) */
  selfPhoneNumber: string;
  
  /** Bot's Signal UUID (if known) */
  selfUuid?: string;
  
  /** Per-group configuration */
  groupsConfig?: Record<string, SignalGroupConfig>;
  
  /** Regex patterns for text-based mention detection */
  mentionPatterns?: string[];
}

export interface SignalGroupGatingResult {
  /** Whether the message should be processed */
  shouldProcess: boolean;
  
  /** Whether bot was mentioned */
  wasMentioned?: boolean;
  
  /** Detection method used */
  method?: 'native' | 'regex' | 'reply' | 'e164';
  
  /** Reason for filtering (if shouldProcess=false) */
  reason?: string;
}

/**
 * Apply group-specific gating logic for Signal messages.
 *
 * Detection methods (in priority order):
 * 1. Native mentions array - Check if bot's phone/UUID is in mentions
 * 2. Regex patterns - Match configured patterns in text
 * 3. Reply to bot - Check if replying to bot's message
 * 4. E.164 fallback - Bot's phone number appears in text
 *
 * @param params - Gating parameters
 * @returns Gating decision
 */
export function applySignalGroupGating(params: SignalGroupGatingParams): SignalGroupGatingResult {
  const { text, groupId, mentions, quote, selfPhoneNumber, selfUuid, groupsConfig, mentionPatterns } = params;

  // Step 1: Check group allowlist (if groups config exists)
  const groups = groupsConfig ?? {};
  const allowlistEnabled = Object.keys(groups).length > 0;

  if (allowlistEnabled) {
    const hasWildcard = Object.hasOwn(groups, '*');
    const hasSpecific = Object.hasOwn(groups, groupId) || Object.hasOwn(groups, `group:${groupId}`);

    if (!hasWildcard && !hasSpecific) {
      return {
        shouldProcess: false,
        reason: 'group-not-in-allowlist',
      };
    }
  }

  // Step 2: Resolve requireMention setting (default: true)
  // Priority: specific group → wildcard → true
  const groupConfig = groups[groupId] ?? groups[`group:${groupId}`];
  const wildcardConfig = groups['*'];
  const requireMention =
    groupConfig?.requireMention ??
    wildcardConfig?.requireMention ??
    true; // Default: require mention for safety

  // If requireMention is false, allow all messages from this group
  if (!requireMention) {
    return {
      shouldProcess: true,
      wasMentioned: false,
    };
  }

  // Step 3: Detect mentions

  // METHOD 1: Native Signal mentions array
  if (mentions && mentions.length > 0) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    
    const mentioned = mentions.some((mention) => {
      // Check UUID match
      if (selfUuid && mention.uuid && mention.uuid === selfUuid) {
        return true;
      }
      // Check phone number match (normalize to digits)
      if (mention.number) {
        const mentionDigits = mention.number.replace(/\D/g, '');
        if (mentionDigits === selfDigits) {
          return true;
        }
      }
      return false;
    });

    if (mentioned) {
      return { shouldProcess: true, wasMentioned: true, method: 'native' };
    }

    // If explicit mentions exist for other users, skip fallback methods
    // (User specifically mentioned someone else, not the bot)
    return { shouldProcess: false, wasMentioned: false, reason: 'mention-required' };
  }

  // METHOD 2: Regex pattern matching
  if (mentionPatterns && mentionPatterns.length > 0) {
    const cleanText = text.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    for (const pattern of mentionPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(cleanText)) {
          return { shouldProcess: true, wasMentioned: true, method: 'regex' };
        }
      } catch (err) {
        console.warn(`[Signal] Invalid mention pattern: ${pattern}`, err);
      }
    }
  }

  // METHOD 3: Reply to bot's message
  if (quote) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    
    // Check if quote author matches bot
    const isReplyToBot =
      (selfUuid && quote.authorUuid === selfUuid) ||
      (quote.author && quote.author.replace(/\D/g, '') === selfDigits);

    if (isReplyToBot) {
      return { shouldProcess: true, wasMentioned: true, method: 'reply' };
    }
  }

  // METHOD 4: E.164 phone number fallback
  if (selfPhoneNumber) {
    const selfDigits = selfPhoneNumber.replace(/\D/g, '');
    const textDigits = text.replace(/\D/g, '');

    if (textDigits.includes(selfDigits)) {
      return { shouldProcess: true, wasMentioned: true, method: 'e164' };
    }
  }

  // No mention detected and mention required - skip this message
  return {
    shouldProcess: false,
    wasMentioned: false,
    reason: 'mention-required',
  };
}
