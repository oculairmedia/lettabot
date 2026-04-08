import { Letta } from '@letta-ai/letta-client';
import { createLogger } from '../logger.js';

const log = createLogger('ConvTitle');

const titledConversations = new Set<string>();

// Read env vars lazily — module may be imported before .env is loaded
function getConfig() {
  return {
    apiUrl: process.env.CONVERSATION_TITLE_API_URL || 'https://api.z.ai/api/coding/paas/v4',
    apiKey: process.env.CONVERSATION_TITLE_API_KEY,
    model: process.env.CONVERSATION_TITLE_MODEL || 'glm-4.5-air',
  };
}

function getClient(): Letta {
  const apiKey = process.env.LETTA_API_KEY;
  const baseURL = process.env.LETTA_BASE_URL || 'https://api.letta.com';
  return new Letta({ 
    apiKey: apiKey || '', 
    baseURL,
    defaultHeaders: { "X-Letta-Source": "lettabot" },
  });
}

async function callGlmForTitle(content: string): Promise<string | null> {
  const { apiUrl, apiKey, model } = getConfig();
  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Generate a concise conversation title (max 6 words). Return ONLY the title text, no quotes or punctuation wrapping.',
        },
        { role: 'user', content },
      ],
      max_tokens: 30,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.warn(`GLM API returned ${response.status}: ${errorText}`);
    return null;
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content?.trim() || null;
}

export async function maybeGenerateConversationTitle(
  conversationId: string,
  userMessage: string,
  agentResponse: string,
): Promise<void> {
  try {
    if (titledConversations.has(conversationId)) return;
    if (!getConfig().apiKey) return;

    titledConversations.add(conversationId);

    const client = getClient();
    const conversation = await client.conversations.retrieve(conversationId);
    if (conversation.summary) {
      log.debug(`Conversation ${conversationId} already has summary: "${conversation.summary}"`);
      return;
    }

    const content = `User: ${userMessage}\nAgent: ${agentResponse}`.slice(0, 500);
    const title = await callGlmForTitle(content);
    if (!title) {
      log.warn('No title generated from GLM API response');
      return;
    }

    await client.conversations.update(conversationId, { summary: title });
    log.info(`Generated title for conversation ${conversationId}: "${title}"`);
  } catch (error) {
    titledConversations.delete(conversationId);
    log.warn('Failed to generate conversation title:', error instanceof Error ? error.message : error);
  }
}

/**
 * Backfill titles for existing conversations that have no summary.
 * Fetches the first user + assistant message pair and generates a title.
 * Runs sequentially with a small delay to avoid hammering the GLM API.
 */
export async function backfillConversationTitles(agentId: string): Promise<void> {
  if (!getConfig().apiKey) {
    log.info('Backfill skipped: CONVERSATION_TITLE_API_KEY not set');
    return;
  }

  const client = getClient();
  let titled = 0;
  let skipped = 0;

  try {
    const conversations = await client.conversations.list({
      agent_id: agentId,
      limit: 100,
      order: 'desc',
    });

    const untitled = conversations.filter(c => !c.summary);
    if (untitled.length === 0) {
      log.info('Backfill: all conversations already have titles');
      return;
    }

    log.info(`Backfill: ${untitled.length} conversations need titles`);

    for (const conv of untitled) {
      try {
        titledConversations.add(conv.id);

        const messagesPage = await client.conversations.messages.list(conv.id, {
          limit: 20,
          include_return_message_types: ['user_message', 'assistant_message'],
        });

        const messages: Array<{ message_type?: string; content?: unknown }> = [];
        for await (const m of messagesPage) {
          messages.push(m as { message_type?: string; content?: unknown });
          if (messages.length >= 20) break;
        }

        const firstUser = messages.find(m => m.message_type === 'user_message');
        const firstAssistant = messages.find(m => m.message_type === 'assistant_message');

        const userText = typeof firstUser?.content === 'string' ? firstUser.content : '';
        const assistantText = typeof firstAssistant?.content === 'string' ? firstAssistant.content : '';

        if (!userText && !assistantText) {
          skipped++;
          continue;
        }

        const content = [
          userText && `User: ${userText}`,
          assistantText && `Agent: ${assistantText}`,
        ].filter(Boolean).join('\n').slice(0, 500);

        const title = await callGlmForTitle(content);
        if (!title) {
          skipped++;
          continue;
        }

        await client.conversations.update(conv.id, { summary: title });
        titled++;
        log.info(`Backfill [${titled}/${untitled.length}] ${conv.id}: "${title}"`);

        // 500ms delay between GLM calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        titledConversations.delete(conv.id);
        log.warn(`Backfill failed for ${conv.id}:`, err instanceof Error ? err.message : err);
        skipped++;
      }
    }
  } catch (error) {
    log.error('Backfill failed:', error instanceof Error ? error.message : error);
    return;
  }

  log.info(`Backfill complete: ${titled} titled, ${skipped} skipped`);
}
