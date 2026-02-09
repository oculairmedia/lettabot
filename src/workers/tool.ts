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
def spawn_worker(task_description: str, model: str = None, tags: list = None, timeout_seconds: int = None) -> str:
    """
    Spawn an ephemeral worker agent to perform a background task asynchronously.
    The worker runs on a cheap model, shares your memory context,
    and writes results to your archival memory when complete.
    You will be notified via a system message when the worker finishes.

    Args:
        task_description: What the worker should do
        model: Optional model override (default: haiku)
        tags: Optional tags for the archival memory entry
        timeout_seconds: Max time the worker can run (default: 300 = 5 min). Set higher for long research tasks.

    Returns:
        A confirmation that the worker was spawned (results arrive later)
    """
    import requests
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
    if timeout_seconds:
        payload["timeout_seconds"] = timeout_seconds

    try:
        resp = requests.post(
            f"{api_url}/api/v1/worker/spawn",
            json=payload,
            timeout=30,
        )
        if resp.status_code in (200, 202):
            data = resp.json()
            wf_id = data.get("workflow_id", "unknown")
            return f"Worker spawned (workflow: {wf_id}). It will run in the background and notify you when complete. Results will be written to your archival memory."
        else:
            return f"Worker failed to spawn: status {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return f"Worker spawn error: {str(e)}"
`;

const WORKER_STATUS_SOURCE = `
def worker_status(workflow_id: str) -> str:
    """
    Check the status of a running or completed worker.

    Args:
        workflow_id: The workflow ID returned by spawn_worker

    Returns:
        Status information about the worker
    """
    import requests
    import os

    api_url = os.environ.get("LETTABOT_API_URL", "http://192.168.50.90:8407")

    try:
        resp = requests.get(
            f"{api_url}/api/v1/worker/status/{workflow_id}",
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            status = data.get("status", "unknown")
            phase = data.get("phase", "")
            error = data.get("error", "")
            parts = [f"Workflow {workflow_id}: {status}"]
            if phase:
                parts.append(f"phase={phase}")
            if error:
                parts.append(f"error={error}")
            return ". ".join(parts)
        elif resp.status_code == 404:
            return f"Workflow {workflow_id} not found (may have already completed and been cleaned up)"
        else:
            return f"Status check failed: {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return f"Status check error: {str(e)}"
`;

export async function registerWorkerTool(agentId: string): Promise<void> {
  const client = getClient();

  const tool = await client.tools.upsert({
    source_code: SPAWN_WORKER_SOURCE,
    description: 'Spawn an ephemeral worker agent for background tasks. Worker shares your memory, runs on cheap model, writes results to archival.',
    tags: ['lettabot', 'worker'],
  });

  const statusTool = await client.tools.upsert({
    source_code: WORKER_STATUS_SOURCE,
    description: 'Check the status of a worker spawn workflow. Use the workflow_id from spawn_worker.',
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

  if (!existingTools.includes('worker_status')) {
    await client.agents.tools.attach(statusTool.id, { agent_id: agentId });
    console.log(`[Worker] Registered worker_status tool on agent ${agentId}`);
  } else {
    console.log('[Worker] worker_status tool already attached');
  }
}
