/**
 * Channel Adapter Interface
 * 
 * Each channel (Telegram, Slack, Discord, WhatsApp, Signal) implements this interface.
 */

import type { ChannelId, InboundMessage, OutboundMessage, OutboundFile } from '../core/types.js';

/**
 * Channel adapter - implement this for each messaging platform
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly name: string;
  
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  
  // Messaging
  sendMessage(msg: OutboundMessage): Promise<{ messageId: string }>;
  sendFile?(msg: OutboundFile): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  sendTypingIndicator(chatId: string): Promise<void>;
  
  // Capabilities (optional)
  supportsEditing?(): boolean;
  sendFile?(file: OutboundFile): Promise<{ messageId: string }>;
  getDmPolicy?(): string;
  
  // Event handlers (set by bot core)
  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;
  
  /**
   * Handler for inter-agent messages (Matrix only)
   * Called when a Letta agent sends a message to this channel.
   * Messages are processed in silent mode - the receiving agent decides whether to respond.
   * 
   * @param senderMxid - The Matrix ID of the sending agent (e.g., @agent_xxx:matrix.oculair.ca)
   * @param text - The message text
   * @param roomId - The Matrix room ID where the message was sent
   */
  onAgentMessage?: (senderMxid: string, text: string, roomId: string) => Promise<void>;
}

/**
 * Typing heartbeat helper - keeps "typing..." indicator active
 */
export class TypingHeartbeat {
  private interval: NodeJS.Timeout | null = null;
  private adapter: ChannelAdapter | null = null;
  private chatId: string | null = null;
  
  start(adapter: ChannelAdapter, chatId: string): void {
    this.stop();
    this.adapter = adapter;
    this.chatId = chatId;
    
    const sendTyping = () => {
      this.adapter?.sendTypingIndicator(this.chatId!).catch(() => {});
    };
    
    sendTyping();
    this.interval = setInterval(sendTyping, 4000); // Most platforms expire typing after 5s
  }
  
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.adapter = null;
    this.chatId = null;
  }
}
