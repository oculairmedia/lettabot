import { Letta } from '@letta-ai/letta-client';

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'http://192.168.50.90:8289';
const LETTA_API_KEY = process.env.LETTA_API_KEY || '';

function getClient(): Letta {
  return new Letta({
    apiKey: LETTA_API_KEY,
    baseURL: LETTA_BASE_URL,
    defaultHeaders: { 'X-Letta-Source': 'lettabot-worker' },
  });
}

const SPAWN_WORKER_SOURCE = `
def spawn_worker(task_description: str, model: str = None, tags: list = None) -> str:
    """
    Spawn an ephemeral worker agent to perform a task in the background.
    The worker runs on a cheap model, shares your memory context,
    and writes results to your archival memory.

    Args:
        task_description: What the worker should do
        model: Optional model override (default: haiku)
        tags: Optional tags for the archival memory entry

    Returns:
        A status message with the worker result summary
    """
    import requests
    import json
    import os

    api_url = os.environ.get("LETTABOT_API_URL", "http://192.168.50.90:8407")
    agent_id = os.environ.get("LETTA_AGENT_ID", "")

    payload = {
        "task_description": task_description,
        "agent_id": agent_id,
    }
    if model:
        payload["model"] = model
    if tags:
        payload["tags"] = tags

    try:
        resp = requests.post(
            f"{api_url}/api/v1/worker/spawn",
            json=payload,
            timeout=600,
        )
        if resp.status_code == 200:
            data = resp.json()
            return f"Worker completed. Response: {data.get('response', '(none)')[:500]}. Passages written: {data.get('passages_written', 0)}"
        else:
            return f"Worker failed with status {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return f"Worker spawn error: {str(e)}"
`;

export async function registerWorkerTool(agentId: string): Promise<void> {
  const client = getClient();

  const tool = await client.tools.upsert({
    source_code: SPAWN_WORKER_SOURCE,
    description: 'Spawn an ephemeral worker agent for background tasks. Worker shares your memory, runs on cheap model, writes results to archival.',
    tags: ['lettabot', 'worker'],
  });

  const existingTools = [];
  const toolsPage = await client.agents.tools.list(agentId);
  for await (const t of toolsPage) {
    existingTools.push(t.name);
  }

  if (!existingTools.includes('spawn_worker')) {
    await client.agents.tools.attach(tool.id, { agent_id: agentId });
    console.log(`[Worker] Registered spawn_worker tool on agent ${agentId}`);
  } else {
    console.log('[Worker] spawn_worker tool already attached');
  }
}
