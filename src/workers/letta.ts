import { Letta } from '@letta-ai/letta-client';

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'http://192.168.50.90:8289';
const LETTA_API_KEY = process.env.LETTA_API_KEY || '';

let client: Letta | null = null;

function getClient(): Letta {
  if (!client) {
    client = new Letta({
      apiKey: LETTA_API_KEY,
      baseURL: LETTA_BASE_URL,
      defaultHeaders: { 'X-Letta-Source': 'lettabot-worker' },
    });
  }
  return client;
}

export async function getAgentBlockIds(agentId: string): Promise<Array<{ id: string; label: string }>> {
  const c = getClient();
  const blocks: Array<{ id: string; label: string }> = [];
  const page = await c.agents.blocks.list(agentId);
  for await (const block of page) {
    if (block.id && block.label) {
      blocks.push({ id: block.id, label: block.label });
    }
  }
  return blocks;
}

export async function createWorkerAgent(opts: {
  mainAgentId: string;
  model: string;
  agentName: string;
  taskPrompt: string;
  blockedTools: string[];
}): Promise<string> {
  const c = getClient();

  const mainBlocks = await getAgentBlockIds(opts.mainAgentId);
  const sharedBlockIds = mainBlocks
    .filter(b => b.label === 'persona' || b.label === 'human')
    .map(b => b.id);

  const agent = await c.agents.create({
    name: opts.agentName,
    model: opts.model,
    embedding: 'openai/text-embedding-3-small',
    memory_blocks: [
      { label: 'task_context', value: opts.taskPrompt },
    ],
    block_ids: sharedBlockIds,
  });

  if (opts.blockedTools.length > 0) {
    const toolsPage = await c.agents.tools.list(agent.id);
    for await (const tool of toolsPage) {
      if (tool.name && opts.blockedTools.includes(tool.name)) {
        await c.agents.tools.detach(tool.name, { agent_id: agent.id });
      }
    }
  }

  console.log(`[Worker] Created agent ${agent.id} (${opts.agentName}) with model=${opts.model}, shared blocks=[${sharedBlockIds.join(', ')}]`);
  return agent.id;
}

export async function deleteWorkerAgent(agentId: string): Promise<void> {
  try {
    const c = getClient();
    await c.agents.delete(agentId);
    console.log(`[Worker] Deleted agent ${agentId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
      console.log(`[Worker] Agent ${agentId} already deleted (404 tolerated)`);
      return;
    }
    throw err;
  }
}

export async function sendMessageToAgent(agentId: string, message: string): Promise<string> {
  const c = getClient();
  const response = await c.agents.messages.create(agentId, {
    input: message,
  });

  let responseText = '';
  for (const msg of response.messages) {
    if ('message_type' in msg && msg.message_type === 'assistant_message') {
      const content = (msg as { content: string | Array<{ text: string }> }).content;
      if (typeof content === 'string') {
        responseText += content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && 'text' in part) {
            responseText += part.text;
          }
        }
      }
    }
  }

  return responseText;
}

export async function writeArchivalPassage(
  agentId: string,
  text: string,
  tags: string[],
): Promise<boolean> {
  const c = getClient();

  if (tags.length > 0) {
    try {
      const existing = await c.agents.passages.search(agentId, {
        query: text.slice(0, 100),
        tags,
        tag_match_mode: 'all',
        top_k: 1,
      });
      if (existing.results.length > 0) {
        console.log(`[Worker] Archival passage with tags [${tags.join(', ')}] already exists, skipping`);
        return false;
      }
    } catch {
      // Search may fail on some server versions — proceed with write
    }
  }

  await c.agents.passages.create(agentId, { text, tags });
  return true;
}

export async function searchArchivalPassages(
  agentId: string,
  query: string,
  limit = 10,
): Promise<Array<{ id: string; content: string; tags?: string[] }>> {
  const c = getClient();
  const result = await c.agents.passages.search(agentId, { query, top_k: limit });
  return result.results.map(r => ({
    id: r.id,
    content: r.content,
    tags: r.tags,
  }));
}

export async function listAgentsByPrefix(prefix: string): Promise<Array<{ id: string; name: string }>> {
  const c = getClient();
  const agents: Array<{ id: string; name: string }> = [];
  const page = await c.agents.list();
  for await (const agent of page) {
    if (agent.name.startsWith(prefix)) {
      agents.push({ id: agent.id, name: agent.name });
    }
  }
  return agents;
}
