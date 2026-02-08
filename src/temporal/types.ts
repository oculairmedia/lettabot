export interface BackgroundTaskInput {
  agentId: string;
  message: string;
  taskType: string;
  backgroundModel: string;
  conversationId: string | null;
  allowedTools: string[];
  cwd: string;
}

export interface BackgroundTaskResult {
  success: boolean;
  taskType: string;
  response: string | null;
  originalModel: string;
  error?: string;
}
