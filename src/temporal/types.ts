export interface BackgroundTaskInput {
  agentId: string;
  message: string;
  taskType: string;
  backgroundModel: string;
}

export interface BackgroundTaskResult {
  success: boolean;
  taskType: string;
  response: string | null;
  originalModel: string;
  error?: string;
}
