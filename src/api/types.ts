/**
 * Request/response types for LettaBot HTTP API
 */

export interface SendMessageRequest {
  channel: string;
  chatId: string;
  text: string;
  threadId?: string;
}

export interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  field?: string;
}

export interface SendFileRequest {
  channel: string;
  chatId: string;
  filePath: string;  // Temporary file path on server
  caption?: string;
  kind?: 'image' | 'file';
  threadId?: string;
}

export interface SendFileResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  field?: string;
}

export interface InjectContextRequest {
  agentName: string;
  text: string;
  source?: string;
}

export interface InjectContextResponse {
  success: boolean;
  response?: string;
  error?: string;
  field?: string;
}
